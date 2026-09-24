import * as fs from 'fs';
import * as path from 'path';
import {
  OriginAccessIdentity,
  Distribution,
  BehaviorOptions,
  ViewerProtocolPolicy,
  PriceClass,
  SecurityPolicyProtocol,
  SSLMethod,
  Function as CloudFrontFunction,
  FunctionEventType,
  FunctionCode,
  FunctionRuntime,
  IOriginAccessIdentity,
} from 'aws-cdk-lib/aws-cloudfront';
import { S3BucketOrigin } from 'aws-cdk-lib/aws-cloudfront-origins';
import { Duration, RemovalPolicy, Stack, StackProps } from 'aws-cdk-lib';
import { Certificate } from 'aws-cdk-lib/aws-certificatemanager';
import { ARecord, HostedZone, RecordTarget } from 'aws-cdk-lib/aws-route53';
import { CloudFrontTarget } from 'aws-cdk-lib/aws-route53-targets';
import { BlockPublicAccess, Bucket, IBucket } from 'aws-cdk-lib/aws-s3';
import { StringParameter } from 'aws-cdk-lib/aws-ssm';
import { Construct } from 'constructs';
import { Architecture, Code, Runtime } from 'aws-cdk-lib/aws-lambda';
import { AccountPrincipal, PolicyStatement } from 'aws-cdk-lib/aws-iam';
import { LogGroup, RetentionDays } from 'aws-cdk-lib/aws-logs';
import { Function } from 'aws-cdk-lib/aws-lambda';
import { TOOLCHAIN_ACCOUNT_ID } from '../../common/config';
import { HostedApp } from './apps';

export type InfrastructureStackProps = {
  /**
   * Apps hosted on this stage's distribution, in registry order. Exactly one must have an empty
   * `pathPrefix`; it becomes the CloudFront default behaviour. Build with `getHostedApps(stage)`.
   */
  hostedApps: HostedApp[];
  configLambdaName: string;
  aliasDomainName: string[];
  reactBuildEnvVariables: Record<string, string>;
};

/**
 * Construct IDs for buckets that are already deployed. CDK derives logical IDs from construct IDs,
 * so these must never change: the buckets use fixed physical names, `RemovalPolicy.DESTROY` and
 * `autoDeleteObjects`, meaning a rename deletes the live assets with no undo.
 *
 * Apps added from here on get the generated `<Id>AssetCloudFrontBucket` form instead.
 */
const LEGACY_BUCKET_CONSTRUCT_IDS: Record<string, string> = {
  orcaui: 'OrcaUIAssetCloudFrontBucket',
  'orcaui-v2': 'OrcaUIv2AssetCloudFrontBucket',
};

/** `orcaui-v2` -> `OrcauiV2`, used to build construct IDs for apps with no legacy ID. */
const pascalCase = (id: string): string =>
  id
    .split(/[^a-zA-Z0-9]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join('');

const bucketConstructId = (app: HostedApp): string =>
  LEGACY_BUCKET_CONSTRUCT_IDS[app.id] ?? `${pascalCase(app.id)}AssetCloudFrontBucket`;

const SPA_REWRITE_TEMPLATE_PATH = path.join(__dirname, 'lambda', 'spa-rewrite.js');

/**
 * Matches the whole `var ROUTE_TABLE = {...};` declaration on a single line.
 *
 * Deliberately strict: it requires the complete braced object to be on one line. A looser pattern
 * such as `^var ROUTE_TABLE = .*$` also matches the first line of a multi-line object, which would
 * replace only that line and leave the remaining entries behind as syntactically broken code.
 */
const SPA_REWRITE_ROUTE_TABLE_DECLARATION = /^var ROUTE_TABLE = \{[^{}\n]*\};$/m;

/**
 * Bake the hosted apps' path prefixes and routing modes into the shared rewrite function.
 * CloudFront Functions take no environment variables, so the table has to be generated rather than
 * configured.
 *
 * Generating it from the same list that creates the CloudFront behaviours is what stops the two from
 * drifting: an app cannot get a behaviour without also getting a routing entry.
 */
export const renderSpaRewriteCode = (hostedApps: HostedApp[]): string => {
  const template = fs.readFileSync(SPA_REWRITE_TEMPLATE_PATH, 'utf8');
  const routeTable = Object.fromEntries(
    hostedApps.map((app) => [app.pathPrefix, app.clientRouting])
  );

  if (!SPA_REWRITE_ROUTE_TABLE_DECLARATION.test(template)) {
    // Without this guard, an edit to spa-rewrite.js could silently ship the template's placeholder
    // table, or a half-replaced one, and apps would serve the wrong page for every deep link.
    throw new Error(
      `${SPA_REWRITE_TEMPLATE_PATH} must contain a single-line "var ROUTE_TABLE = {...};" ` +
        'declaration for synth to replace. Restore it to one line before deploying.'
    );
  }

  return template.replace(
    SPA_REWRITE_ROUTE_TABLE_DECLARATION,
    `var ROUTE_TABLE = ${JSON.stringify(routeTable)};`
  );
};

/**
 * Shared hosting for every frontend on `portal.<stage>.umccr.org`.
 *
 * One S3 bucket per app, one CloudFront distribution serving all of them by path prefix, one env
 * config Lambda writing each app's `env.js`. Physical names still say `OrcaUI` because they are
 * deployed identities that predate the other apps.
 */
export class InfrastructureStack extends Stack {
  constructor(scope: Construct, id: string, props: InfrastructureStackProps & StackProps) {
    super(scope, id, props);

    const rootApp = props.hostedApps.find((app) => app.pathPrefix === '');
    if (!rootApp) {
      throw new Error(
        'InfrastructureStack requires exactly one hosted app with an empty pathPrefix'
      );
    }

    // Created in registry order so that adding an app appends to the synthesized template rather
    // than reshuffling existing resources.
    const buckets = new Map<string, IBucket>(
      props.hostedApps.map((app) => [
        app.id,
        new Bucket(this, bucketConstructId(app), {
          bucketName: app.bucketName,
          autoDeleteObjects: true,
          enforceSSL: true,
          removalPolicy: RemovalPolicy.DESTROY,
          websiteIndexDocument: 'index.html',
          websiteErrorDocument: 'index.html',
          blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
        }),
      ])
    );

    const distribution = this.setupS3CloudFrontIntegration(
      props.hostedApps,
      buckets,
      props.aliasDomainName
    );

    /*
      Writes each app's env.js and invalidates the distribution. Invoked by the app deploy
      pipelines after they sync assets to S3. Three stages:
      1. read env variables and SSM parameters
      2. write env.js into every hosted app's bucket
      3. invalidate the CloudFront cache
    */

    const logGroup = new LogGroup(this, 'EnvConfigLambdaLogGroup', {
      retention: RetentionDays.ONE_WEEK,
    });

    const configLambda = new Function(this, 'EnvConfigLambda', {
      functionName: props.configLambdaName,
      code: Code.fromAsset(path.join(__dirname, 'lambda')),
      timeout: Duration.minutes(10),
      handler: 'env_config_and_cdn_refresh.handler',
      logGroup: logGroup,
      runtime: Runtime.PYTHON_3_12,
      architecture: Architecture.ARM_64,
      memorySize: 1024,
      environment: {
        VITE_REGION: 'ap-southeast-2',
        // Where env.js goes, per app. The handler iterates this, so a new app needs no Lambda
        // change. `id` lets a caller target one app via an {"app": "<id>"} invoke payload.
        PORTAL_APP_TARGETS: JSON.stringify(
          props.hostedApps.map((app) => ({
            id: app.id,
            bucket: app.bucketName,
            key: app.pathPrefix ? `${app.pathPrefix}/env.js` : 'env.js',
          }))
        ),
        CLOUDFRONT_DISTRIBUTION_ID: distribution.distributionId,
        ...props.reactBuildEnvVariables,
      },
    });

    for (const bucket of buckets.values()) {
      bucket.grantReadWrite(configLambda);
    }
    distribution.grantCreateInvalidation(configLambda);
    // Grant SSM read permissions to the Lambda function
    configLambda.addToRolePolicy(
      new PolicyStatement({
        actions: ['ssm:Get*'],
        resources: [
          `arn:aws:ssm:${this.region}:${this.account}:parameter/orcaui/*`,
          `arn:aws:ssm:${this.region}:${this.account}:parameter/data_portal/*`,
        ],
      })
    );
    // Grant KMS decrypt for SecureString parameters encrypted with the AWS managed SSM key.
    configLambda.addToRolePolicy(
      new PolicyStatement({
        actions: ['kms:Decrypt'],
        resources: [`arn:aws:kms:${this.region}:${this.account}:key/*`],
        conditions: {
          StringEquals: {
            'kms:CallerAccount': this.account,
            'kms:ViaService': `ssm.${this.region}.amazonaws.com`,
          },
          'ForAnyValue:StringEquals': {
            'kms:ResourceAliases': 'alias/aws/ssm',
          },
        },
      })
    );

    /*
      Grant the toolchain account access to the S3 buckets and lambda function, so the app deploy
      pipelines can sync artifacts and invoke the lambda.
    */
    for (const bucket of buckets.values()) {
      bucket.grantDelete(new AccountPrincipal(TOOLCHAIN_ACCOUNT_ID));
      bucket.grantReadWrite(new AccountPrincipal(TOOLCHAIN_ACCOUNT_ID));
    }

    configLambda.grantInvoke(new AccountPrincipal(TOOLCHAIN_ACCOUNT_ID));
  }

  private setupS3CloudFrontIntegration(
    hostedApps: HostedApp[],
    buckets: Map<string, IBucket>,
    aliasDomainName: string[]
  ): Distribution {
    const hostedZoneName = StringParameter.valueForStringParameter(this, '/hosted_zone/umccr/name');
    const hostedZoneId = StringParameter.valueForStringParameter(this, '/hosted_zone/umccr/id');

    const hostedZone = HostedZone.fromHostedZoneAttributes(this, 'HostedZone', {
      hostedZoneId: hostedZoneId,
      zoneName: hostedZoneName,
    });

    const certUse1Arn = StringParameter.valueForStringParameter(this, '/orcaui/certificate_arn');
    const certUse1 = Certificate.fromCertificateArn(this, 'SSLCertificateUSE1', certUse1Arn);

    const cloudFrontOAI = new OriginAccessIdentity(this, 'CloudFrontOAI', {
      comment: 'orca-ui OAI',
    });

    const spaRewriteFn = new CloudFrontFunction(this, 'SpaRewriteFn', {
      runtime: FunctionRuntime.JS_2_0,
      code: FunctionCode.fromInline(renderSpaRewriteCode(hostedApps)),
    });

    const behaviorFor = (app: HostedApp): BehaviorOptions =>
      this.spaBehavior(buckets.get(app.id)!, cloudFrontOAI, spaRewriteFn);

    const rootApp = hostedApps.find((app) => app.pathPrefix === '')!;
    const additionalBehaviors = Object.fromEntries(
      hostedApps
        .filter((app) => app.pathPrefix !== '')
        .map((app) => [`/${app.pathPrefix}/*`, behaviorFor(app)])
    );

    const cloudFrontDistribution = new Distribution(this, 'CloudFrontDistribution', {
      defaultBehavior: behaviorFor(rootApp),
      additionalBehaviors:
        Object.keys(additionalBehaviors).length > 0 ? additionalBehaviors : undefined,
      defaultRootObject: 'index.html',
      priceClass: PriceClass.PRICE_CLASS_ALL,
      enableIpv6: false,
      certificate: certUse1,
      domainNames: aliasDomainName,
      minimumProtocolVersion: SecurityPolicyProtocol.TLS_V1_2_2021,
      sslSupportMethod: SSLMethod.SNI,
    });

    // Support dual access via both 'portal' and 'orcaui' subdomains.
    // Both A records alias to the same CloudFront distribution at no additional cost.
    // This enables a gradual domain migration from 'orcaui' to 'portal' while maintaining backward compatibility.

    new ARecord(this, 'PortalDomainAlias', {
      target: RecordTarget.fromAlias(new CloudFrontTarget(cloudFrontDistribution)),
      zone: hostedZone,
      recordName: 'portal',
    });

    new ARecord(this, 'CustomDomainAlias', {
      target: RecordTarget.fromAlias(new CloudFrontTarget(cloudFrontDistribution)),
      zone: hostedZone,
      recordName: 'orcaui',
    });

    return cloudFrontDistribution;
  }

  /** Identical behaviour for every app: private S3 origin via OAI, HTTPS only, SPA rewrite. */
  private spaBehavior(
    bucket: IBucket,
    originAccessIdentity: IOriginAccessIdentity,
    spaRewriteFn: CloudFrontFunction
  ): BehaviorOptions {
    return {
      origin: S3BucketOrigin.withOriginAccessIdentity(bucket, {
        originAccessIdentity,
      }),
      viewerProtocolPolicy: ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
      functionAssociations: [
        {
          function: spaRewriteFn,
          eventType: FunctionEventType.VIEWER_REQUEST,
        },
      ],
    };
  }
}

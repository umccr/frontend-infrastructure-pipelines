import { App } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { describe, expect, test } from '@jest/globals';
import { accountIdAlias, AppStage } from '../../lib/common/config';
import { InfrastructureStack } from '../../lib/portal/infrastructure-stack';
import { getInfrastructureStackConfig } from '../../lib/portal/config';
import {
  GAMMA_GAP_APPS,
  getHostedApps,
  HUB_APP,
  ORCAHOUSE_APP,
  ORCAUI_APP,
  ORCAUI_V2_APP,
} from '../../lib/portal/apps';
import {
  acknowledgeFindings,
  addAwsSolutionsChecks,
  expectNoUnacknowledgedFindings,
} from '../common/cdk-nag-helpers';

type CfnResource = {
  Properties?: Record<string, unknown>;
};

type CloudFrontDistributionResource = {
  Properties: {
    DistributionConfig?: {
      CacheBehaviors?: Array<{ PathPattern?: string }>;
      DefaultCacheBehavior?: Record<string, unknown>;
    };
  };
};

// AwsSolutions findings accepted for the portal InfrastructureStack.
const ACCEPTED_INFRASTRUCTURE_RULES = [
  'AwsSolutions-IAM4', // allow to use AWS managed policy
  'AwsSolutions-IAM5', // wildcard scoped to the CloudFront bucket
  'AwsSolutions-L1', // allow non latest lambda runtime
  'AwsSolutions-S1', // no access logs required for now
  'AwsSolutions-CFR1', // public access without geo restrictions
  'AwsSolutions-CFR2', // WAF intentionally disabled
  'AwsSolutions-CFR3', // no access logs required for now
  'AwsSolutions-CFR7', // OAI pending migration to OAC
];

const synth = (appStage: AppStage): Template =>
  Template.fromStack(
    new InfrastructureStack(new App({}), `${appStage}InfrastructureStack`, {
      env: { account: accountIdAlias[appStage], region: 'ap-southeast-2' },
      tags: { 'umccr-org:Product': 'OrcaUI', 'umccr-org:Creator': 'CDK' },
      ...getInfrastructureStackConfig(appStage),
    })
  );

const distributionConfig = (template: Template) => {
  const distributions = Object.values(
    template.findResources('AWS::CloudFront::Distribution')
  ) as CloudFrontDistributionResource[];
  expect(distributions).toHaveLength(1);
  return distributions[0].Properties.DistributionConfig ?? {};
};

const bucketNames = (template: Template): string[] =>
  (Object.values(template.findResources('AWS::S3::Bucket')) as CfnResource[])
    .map((bucket) => bucket.Properties?.BucketName)
    .filter((name): name is string => typeof name === 'string');

const lambdaEnvironment = (template: Template): Record<string, string> => {
  const fn = Object.values(template.findResources('AWS::Lambda::Function')).find((resource) => {
    const variables = (resource as { Properties?: { Environment?: { Variables?: object } } })
      .Properties?.Environment?.Variables;
    return variables && 'PORTAL_APP_TARGETS' in variables;
  });
  expect(fn).toBeDefined();
  return (fn as { Properties: { Environment: { Variables: Record<string, string> } } }).Properties
    .Environment.Variables;
};

const spaRewriteCode = (template: Template): string => {
  const fns = Object.values(template.findResources('AWS::CloudFront::Function')) as {
    Properties?: { FunctionCode?: string };
  }[];
  // One shared function for every behaviour; see renderSpaRewriteCode in infrastructure-stack.ts.
  expect(fns).toHaveLength(1);
  const code = fns[0].Properties?.FunctionCode;
  expect(typeof code).toBe('string');
  return code!;
};

describe('cdk-nag-stack', () => {
  const app: App = new App({});

  const stack = new InfrastructureStack(app, 'InfrastructureStack', {
    env: {
      account: '123456789012',
      region: 'ap-southeast-2',
    },
    tags: {
      'umccr-org:Product': 'OrcaUI',
      'umccr-org:Creator': 'CDK',
    },
    ...getInfrastructureStackConfig(AppStage.PROD),
  });

  const stackId = stack.node.id;

  addAwsSolutionsChecks(stack);
  acknowledgeFindings(
    stack,
    ACCEPTED_INFRASTRUCTURE_RULES,
    'Accepted for portal hosting infrastructure'
  );

  test(`${stackId}: cdk-nag AwsSolutions Pack reports no unacknowledged findings`, () => {
    expect(() => expectNoUnacknowledgedFindings(app)).not.toThrow();
  });

  test(`${stackId}: grants SecureString decrypt without CDK context lookup`, () => {
    const template = Template.fromStack(stack);

    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: Match.objectLike({
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: 'kms:Decrypt',
            Condition: {
              StringEquals: {
                'kms:CallerAccount': '123456789012',
                'kms:ViaService': 'ssm.ap-southeast-2.amazonaws.com',
              },
              'ForAnyValue:StringEquals': {
                'kms:ResourceAliases': 'alias/aws/ssm',
              },
            },
            Resource: 'arn:aws:kms:ap-southeast-2:123456789012:key/*',
          }),
        ]),
      }),
    });
  });
});

/**
 * The two buckets below are already deployed with fixed physical names,
 * `RemovalPolicy.DESTROY` and `autoDeleteObjects`. If their logical IDs change, CloudFormation
 * deletes the live assets, so this is the highest-value assertion in the file.
 */
describe('deployed logical IDs are preserved', () => {
  test.each(Object.values(AppStage))('%s keeps the legacy bucket logical IDs', (appStage) => {
    const logicalIds = Object.keys(synth(appStage).findResources('AWS::S3::Bucket'));

    expect(logicalIds).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^OrcaUIAssetCloudFrontBucket/),
        expect.stringMatching(/^OrcaUIv2AssetCloudFrontBucket/),
      ])
    );
  });
});

describe.each(Object.values(AppStage))('%s hosting', (appStage) => {
  const hostedApps = getHostedApps(appStage);
  const prefixedApps = hostedApps.filter((hostedApp) => hostedApp.pathPrefix !== '');

  test('hosts exactly one root app, and it is the CloudFront default behaviour', () => {
    const config = distributionConfig(synth(appStage));

    expect(hostedApps.filter((hostedApp) => hostedApp.pathPrefix === '')).toHaveLength(1);
    expect(config.DefaultCacheBehavior).toBeDefined();
    expect(config.CacheBehaviors ?? []).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ PathPattern: '/*' })])
    );
  });

  test('creates one bucket per hosted app', () => {
    const names = bucketNames(synth(appStage));

    expect(names.sort()).toEqual(hostedApps.map((hostedApp) => hostedApp.bucketName).sort());
  });

  test('creates one CloudFront behaviour per path-prefixed app', () => {
    const patterns = (distributionConfig(synth(appStage)).CacheBehaviors ?? []).map(
      (behavior) => behavior.PathPattern
    );

    expect(patterns.sort()).toEqual(
      prefixedApps.map((hostedApp) => `/${hostedApp.pathPrefix}/*`).sort()
    );
  });

  test('SPA rewrite route table matches the hosted apps exactly', () => {
    const code = spaRewriteCode(synth(appStage));
    const declaration = /^var ROUTE_TABLE = (\{.*\});$/m.exec(code);

    expect(declaration).not.toBeNull();
    // Every hosted app, root included, with the routing mode from the registry. A behaviour without
    // a matching entry would serve the wrong app's HTML.
    expect(JSON.parse(declaration![1])).toEqual(
      Object.fromEntries(
        hostedApps.map((hostedApp) => [hostedApp.pathPrefix, hostedApp.clientRouting])
      )
    );
    // The template's placeholder default must not survive into a synthesized function.
    expect(code).not.toContain("var ROUTE_TABLE = { '': 'spa', v2: 'spa' };");
  });

  test('every path-prefixed app has both a behaviour and a route table entry', () => {
    const template = synth(appStage);
    const patterns = (distributionConfig(template).CacheBehaviors ?? []).map(
      (behavior) => behavior.PathPattern
    );
    const routeTable = JSON.parse(
      /^var ROUTE_TABLE = (\{.*\});$/m.exec(spaRewriteCode(template))![1]
    ) as Record<string, string>;

    expect(patterns.sort()).toEqual(
      Object.keys(routeTable)
        .filter((prefix) => prefix !== '')
        .map((prefix) => `/${prefix}/*`)
        .sort()
    );
  });

  test('env config Lambda targets every hosted app bucket and key', () => {
    const environment = lambdaEnvironment(synth(appStage));

    expect(JSON.parse(environment.PORTAL_APP_TARGETS)).toEqual(
      hostedApps.map((hostedApp) => ({
        id: hostedApp.id,
        bucket: hostedApp.bucketName,
        key: hostedApp.pathPrefix ? `${hostedApp.pathPrefix}/env.js` : 'env.js',
      }))
    );
  });

  test('env config Lambda no longer carries the superseded bucket variables', () => {
    const environment = lambdaEnvironment(synth(appStage));

    expect(environment).not.toHaveProperty('BUCKET_NAME');
    expect(environment).not.toHaveProperty('V2_BUCKET_NAME');
  });
});

/**
 * Rollout guard. Hub and OrcaHouse are beta-only on purpose; promoting them is a deliberate edit to
 * `bucketName` in apps.ts, which should also update this test.
 */
describe('staged rollout', () => {
  test('OrcaUI and OrcaUI v2 are hosted in every stage', () => {
    for (const appStage of Object.values(AppStage)) {
      const ids = getHostedApps(appStage).map((hostedApp) => hostedApp.id);
      expect(ids).toContain(ORCAUI_APP.id);
      expect(ids).toContain(ORCAUI_V2_APP.id);
    }
  });

  test('Hub and OrcaHouse are hosted in beta and prod, but not gamma', () => {
    for (const appStage of [AppStage.BETA, AppStage.PROD]) {
      const ids = getHostedApps(appStage).map((hostedApp) => hostedApp.id);
      expect(ids).toContain(HUB_APP.id);
      expect(ids).toContain(ORCAHOUSE_APP.id);
    }

    const gammaIds = getHostedApps(AppStage.GAMMA).map((hostedApp) => hostedApp.id);
    expect(gammaIds).not.toContain(HUB_APP.id);
    expect(gammaIds).not.toContain(ORCAHOUSE_APP.id);
  });

  test('GAMMA_GAP_APPS names exactly the apps that reach prod without a gamma soak', () => {
    // Deliberate trade for delivery speed. If a gamma bucket is added, this list shrinks and the
    // assertion should be updated rather than the export quietly going stale.
    expect(GAMMA_GAP_APPS.map((app) => app.id).sort()).toEqual(['hub', 'orcahouse']);
  });

  test('an unhosted app gets no bucket, behaviour or rewrite entry', () => {
    const template = synth(AppStage.GAMMA);

    expect(bucketNames(template)).not.toContain(HUB_APP.bucketName[AppStage.BETA]);
    expect(
      (distributionConfig(template).CacheBehaviors ?? []).map((b) => b.PathPattern)
    ).not.toContain('/hub/*');
    expect(spaRewriteCode(template)).not.toContain('hub');
  });
});

describe('registry validation', () => {
  test('rejects a stage with no root app', () => {
    expect(() => getHostedApps('nonexistent' as AppStage)).toThrow(
      /Exactly one portal app must serve the site root/
    );
  });
});

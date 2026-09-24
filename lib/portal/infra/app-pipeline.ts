import {
  BuildSpec,
  IBuildImage,
  LinuxArmBuildImage,
  PipelineProject,
} from 'aws-cdk-lib/aws-codebuild';
import {
  Artifact,
  CfnPipeline,
  Pipeline,
  PipelineType,
  StageProps,
} from 'aws-cdk-lib/aws-codepipeline';
import {
  CodeBuildAction,
  CodeStarConnectionsSourceAction,
  ManualApprovalAction,
} from 'aws-cdk-lib/aws-codepipeline-actions';
import { Effect, PolicyStatement, Role, ServicePrincipal } from 'aws-cdk-lib/aws-iam';
import { StringParameter } from 'aws-cdk-lib/aws-ssm';
import { Construct } from 'constructs';
import { accountIdAlias, AppStage, REGION } from '../../common/config';
import { PortalApp, requireBucketName } from './apps';
import { configLambdaNameConfig } from './config';

/**
 * Build-and-deploy pipeline for one portal app.
 *
 * Everything stage-related is derived from the app's registry entry: a stage with no bucket in
 * `PortalApp.bucketName` gets no deploy stage, so an app rolls out beta first by configuration
 * rather than by editing this construct. Prod is always gated behind a manual approval.
 *
 * The pipeline runs in the toolchain account and deploys cross-account into each stage's bucket.
 * It is not self-mutating: `cdk deploy` updates the pipeline definition without starting a release.
 */
export interface PortalAppPipelineProps {
  /** Registry entry, supplying the path prefix, per-stage buckets and source repo. */
  readonly app: PortalApp;

  /**
   * Prefix for physical resource names: `<namePrefix>AppCICDPipeline`, `<namePrefix>BuildProject`,
   * `<namePrefix>DeployProject<Stage>`. Must be unique across the toolchain account, which shares
   * one namespace with OrcaUI's existing pipelines.
   */
  readonly namePrefix: string;

  /** Branch to build. Defaults to `main`. */
  readonly branch?: string;

  /** Commands that build the app. Run after the install phase. */
  readonly buildCommands: string[];

  /**
   * Directory the build writes its servable output to, relative to the repo root. Its **contents**
   * are the deploy artifact, so it must contain `index.html` at its top level.
   *
   * Note for Next.js: this is the `out/` produced by `output: 'export'`, never `.next/`, which is a
   * build cache and not a servable site.
   */
  readonly artifactBaseDirectory: string;

  /**
   * Node major version for CodeBuild. Defaults to 24.
   *
   * Pin it deliberately rather than tracking latest: Corepack is being unbundled from newer Node
   * releases, and the install phase depends on it to resolve the app's pinned pnpm.
   */
  readonly nodeVersion?: number;

  /**
   * Optional checks run against the source before the gamma deploy, for apps that validate
   * themselves against staging API schemas. Omitted for apps that do not.
   */
  readonly gammaPreDeployCommands?: string[];

  /** Source paths that should not trigger a release, e.g. docs-only directories. */
  readonly triggerFilePathExcludes?: string[];

  /**
   * Extra build outputs that must never be cached, on top of {@link NEVER_CACHE_GLOBS}.
   *
   * Anything the client fetches by a stable, unhashed name belongs here. Next.js App Router static
   * exports, for example, emit `.txt` RSC payloads next to each `index.html`; caching those
   * immutably while the HTML is uncacheable makes client-side navigation serve stale content.
   */
  readonly additionalNeverCacheGlobs?: string[];

  /**
   * Extra build outputs to keep out of the bucket entirely, on top of {@link DO_NOT_UPLOAD_GLOBS}.
   */
  readonly additionalDoNotUploadGlobs?: string[];
}

/**
 * Build outputs the client fetches by a stable name, so they must revalidate on every request.
 * Everything else in a modern build has a content hash in its filename and can cache forever.
 *
 * A leading star in an S3 CLI filter matches `/` as well, unlike shell globbing, so a pattern such
 * as the second entry below matches an `index.html` at any depth, not just one level down.
 */
const NEVER_CACHE_GLOBS = [
  'index.html',
  '*/index.html',
  '404.html',
  'robots.txt',
  'manifest.json',
  '*.webmanifest',
  '*.ico',
];

/**
 * Objects written by the env config Lambda rather than the build. Excluded from both sync passes:
 * without this, `--delete` would remove the live `env.js` before the Lambda rewrites it, leaving a
 * window where the app loads with no runtime config.
 *
 * Apps may also ship a placeholder `env.js` for local development; excluding it stops that
 * placeholder overwriting the real per-environment config.
 */
const LAMBDA_OWNED_GLOBS = ['env.js', '*/env.js'];

/**
 * Build outputs that must never reach the bucket.
 *
 * Source maps are public the moment they are uploaded: the bucket is served by CloudFront and a
 * `.map` beside a bundle is fetchable by name whether or not the bundle links to it. Builds that set
 * `sourcemap: 'hidden'` intend the opposite, so keep them out of the artifact rather than relying on
 * the missing `sourceMappingURL` comment.
 */
const DO_NOT_UPLOAD_GLOBS = ['*.map'];

/**
 * Node major version used unless an app overrides it. 24 matches both current portal apps: OrcaHouse
 * pins it in `.nvmrc` and Hub's own CI runs it.
 */
const DEFAULT_NODE_VERSION = 24;

/** Beta, gamma, prod in promotion order. Deploy stages are emitted in this order. */
const PROMOTION_ORDER: AppStage[] = [AppStage.BETA, AppStage.GAMMA, AppStage.PROD];

const STAGE_LABEL: Record<AppStage, string> = {
  [AppStage.BETA]: 'Beta',
  [AppStage.GAMMA]: 'Gamma',
  [AppStage.PROD]: 'Prod',
};

/**
 * Fails the deploy if the env config Lambda reported an error, rather than letting a green pipeline
 * hide a broken `env.js`. `aws lambda invoke` exits 0 even when the function itself failed.
 */
const VALIDATE_CONFIG_LAMBDA_RESPONSE =
  "python3 -c \"import json, sys; meta=json.load(open('invoke-result.json')); payload=json.load(open('response.json')); print(payload.get('body', payload)); sys.exit(1 if meta.get('FunctionError') or payload.get('statusCode') != 200 else 0)\"";

export class PortalAppPipeline extends Construct {
  private readonly buildImage: IBuildImage = LinuxArmBuildImage.AMAZON_LINUX_2023_STANDARD_3_0;

  constructor(
    scope: Construct,
    id: string,
    private readonly props: PortalAppPipelineProps
  ) {
    super(scope, id);

    const { app, namePrefix } = props;
    const branch = props.branch ?? 'main';
    const [owner, repo] = app.repo.split('/');
    if (!owner || !repo) {
      throw new Error(
        `Portal app '${app.id}' has an invalid repo '${app.repo}'; expected owner/repo`
      );
    }

    const codeStarArn = StringParameter.valueForStringParameter(this, 'codestar_github_arn');
    const sourceOutput = new Artifact();
    const buildOutput = new Artifact();
    const sourceActionName = `${app.id}AppSrc`;

    const stages: StageProps[] = [
      {
        stageName: 'Source',
        actions: [
          new CodeStarConnectionsSourceAction({
            actionName: sourceActionName,
            owner,
            repo,
            branch,
            connectionArn: codeStarArn,
            output: sourceOutput,
            triggerOnPush: true,
          }),
        ],
      },
      {
        stageName: 'Build',
        actions: [
          new CodeBuildAction({
            actionName: 'BuildApp',
            project: this.buildProject(),
            input: sourceOutput,
            outputs: [buildOutput],
          }),
        ],
      },
    ];

    for (const appStage of PROMOTION_ORDER) {
      if (!app.bucketName[appStage]) {
        continue;
      }
      const label = STAGE_LABEL[appStage];

      // Never promote to prod without a human. Its own stage so the approval is visible in the
      // pipeline view rather than buried as a run-order step inside the gamma stage.
      if (appStage === AppStage.PROD) {
        stages.push({
          stageName: 'DeployToProdApproval',
          actions: [new ManualApprovalAction({ actionName: 'ApproveDeployToProd' })],
        });
      }

      const actions = [];
      let runOrder = 1;

      if (appStage === AppStage.GAMMA && props.gammaPreDeployCommands?.length) {
        actions.push(
          new CodeBuildAction({
            actionName: 'CheckAgainstStgSchemas',
            project: this.gammaPreDeployProject(props.gammaPreDeployCommands),
            input: sourceOutput,
            runOrder: runOrder++,
          })
        );
      }

      actions.push(
        new CodeBuildAction({
          actionName: `DeployTo${label}`,
          project: this.deployProject(appStage),
          input: buildOutput,
          runOrder: runOrder,
        })
      );

      stages.push({ stageName: `DeployTo${label}`, actions });
    }

    const pipeline = new Pipeline(this, 'Pipeline', {
      pipelineType: PipelineType.V2,
      pipelineName: `${namePrefix}AppCICDPipeline`,
      crossAccountKeys: false,
      stages,
    });

    if (props.triggerFilePathExcludes?.length) {
      const cfnPipeline = pipeline.node.defaultChild as CfnPipeline;
      cfnPipeline.addPropertyOverride('Triggers', [
        {
          GitConfiguration: {
            Push: [
              {
                Branches: { Includes: [branch] },
                FilePaths: { Excludes: props.triggerFilePathExcludes },
              },
            ],
            SourceActionName: sourceActionName,
          },
          ProviderType: 'CodeStarSourceConnection',
        },
      ]);
    }
  }

  /**
   * Install the exact pnpm each app pins in its own `packageManager` field.
   *
   * `corepack enable` only installs the shims; on its own it has been observed here to run whatever
   * pnpm the CodeBuild image defaults to, which can reject a lockfile written by a different major
   * version and fail `--frozen-lockfile`. `corepack install` reads the checked-out `package.json` and
   * fetches that version, so the portal repo never has to duplicate each app's pnpm version.
   *
   * `pnpm --version` is kept so the resolved version is visible in the build log: a mismatch between
   * it and the app's `packageManager` is the first thing to check if an install starts failing.
   */
  private installCommands(): string[] {
    return [
      'node -v',
      'corepack enable',
      'corepack install',
      'pnpm --version',
      'pnpm install --frozen-lockfile',
    ];
  }

  private buildProject(): PipelineProject {
    const { namePrefix, buildCommands, artifactBaseDirectory } = this.props;

    return new PipelineProject(this, 'BuildProject', {
      projectName: `${namePrefix}BuildProject`,
      description: `Build ${namePrefix} for the portal`,
      buildSpec: BuildSpec.fromObject({
        version: 0.2,
        phases: {
          install: {
            'runtime-versions': { nodejs: this.props.nodeVersion ?? DEFAULT_NODE_VERSION },
            commands: this.installCommands(),
          },
          build: { commands: ['set -eu', ...buildCommands] },
        },
        artifacts: {
          files: ['**/**'],
          'base-directory': artifactBaseDirectory,
        },
      }),
      environment: { buildImage: this.buildImage },
    });
  }

  private gammaPreDeployProject(commands: string[]): PipelineProject {
    const { namePrefix } = this.props;

    return new PipelineProject(this, 'GammaPreDeployProject', {
      projectName: `${namePrefix}GammaPreDeployProject`,
      description: `Validate ${namePrefix} against staging schemas before the gamma deploy`,
      buildSpec: BuildSpec.fromObject({
        version: 0.2,
        phases: {
          install: {
            'runtime-versions': { nodejs: this.props.nodeVersion ?? DEFAULT_NODE_VERSION },
            commands: this.installCommands(),
          },
          build: { commands: ['set -eu', ...commands] },
        },
      }),
      environment: { buildImage: this.buildImage },
    });
  }

  /**
   * Upload the artifact in two passes so that a deploy cannot break a session that is already open.
   *
   * Hashed asset filenames are immutable and cache for a year. The HTML shell must revalidate every
   * time, because `--delete` removes the previous build's hashed chunks immediately: a browser
   * holding a cached shell would otherwise request files that no longer exist.
   *
   * Both passes are derived from one glob list, so a file cannot be excluded from the first pass
   * without being included in the second. Hand-maintaining the two lists risked never uploading it.
   */
  private syncCommands(): string[] {
    const neverCache = [...NEVER_CACHE_GLOBS, ...(this.props.additionalNeverCacheGlobs ?? [])];
    const doNotUpload = [...DO_NOT_UPLOAD_GLOBS, ...(this.props.additionalDoNotUploadGlobs ?? [])];
    const excludes = (globs: string[]) => globs.map((glob) => `--exclude "${glob}"`).join(' ');
    const includes = (globs: string[]) => globs.map((glob) => `--include "${glob}"`).join(' ');

    return [
      // Pass one: hashed assets, cached for a year, with --delete pruning the previous build.
      `aws s3 sync . s3://\${DESTINATION_PATH} --delete --cache-control "public,max-age=31536000,immutable" ${excludes([...neverCache, ...doNotUpload, ...LAMBDA_OWNED_GLOBS])}`,
      // Pass two: exactly what pass one held back for caching reasons, so nothing is left unuploaded.
      // Deliberately not --delete: it would prune everything pass one just wrote.
      `aws s3 sync . s3://\${DESTINATION_PATH} --cache-control "no-cache" --exclude "*" ${includes(neverCache)}`,
    ];
  }

  private deployProject(appStage: AppStage): PipelineProject {
    const { app, namePrefix } = this.props;
    const label = STAGE_LABEL[appStage];
    const bucketName = requireBucketName(app, appStage);
    const configLambdaName = configLambdaNameConfig[appStage];

    const role = new Role(this, `DeployProjectRole${label}`, {
      assumedBy: new ServicePrincipal('codebuild.amazonaws.com'),
    });
    role.addToPolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: ['s3:Get*', 's3:List*', 's3:PutObject', 's3:DeleteObject'],
        resources: [`arn:aws:s3:::${bucketName}`, `arn:aws:s3:::${bucketName}/*`],
      })
    );
    role.addToPolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: ['lambda:InvokeFunction'],
        resources: [
          `arn:aws:lambda:${REGION}:${accountIdAlias[appStage]}:function:${configLambdaName}`,
        ],
      })
    );

    return new PipelineProject(this, `DeployProject${label}`, {
      projectName: `${namePrefix}DeployProject${label}`,
      description: `Deploy ${namePrefix} to ${appStage}`,
      buildSpec: BuildSpec.fromObject({
        version: 0.2,
        phases: {
          build: {
            commands: [
              'set -eu',
              ...this.syncCommands(),
              // Writes this app's env.js only. Without the payload the Lambda rewrites every
              // portal app's config, which is correct but needlessly broad for one app's deploy.
              'aws lambda invoke --function-name arn:aws:lambda:${REGION}:${DESTINATION_ACCOUNT_ID}:function:${CONFIG_LAMBDA_NAME} --cli-binary-format raw-in-base64-out --payload "{\\"app\\":\\"${PORTAL_APP_ID}\\"}" response.json > invoke-result.json',
              VALIDATE_CONFIG_LAMBDA_RESPONSE,
            ],
          },
        },
      }),
      environment: { buildImage: this.buildImage },
      environmentVariables: {
        // Trailing slash matters: it makes sync target the prefix as a directory.
        DESTINATION_PATH: {
          value: app.pathPrefix ? `${bucketName}/${app.pathPrefix}/` : bucketName,
        },
        CONFIG_LAMBDA_NAME: { value: configLambdaName },
        REGION: { value: REGION },
        DESTINATION_ACCOUNT_ID: { value: accountIdAlias[appStage] },
        PORTAL_APP_ID: { value: app.id },
      },
      role,
    });
  }
}

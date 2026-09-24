import { Construct } from 'constructs';
import { DeploymentStackPipeline } from '@orcabus/platform-cdk-constructs/deployment-stack-pipeline';
import { InfrastructureStack } from './infrastructure-stack';
import { AppStage } from '../../common/config';
import { getInfrastructureStackConfig } from './config';
import { Stack, StackProps } from 'aws-cdk-lib';

/**
 * Repository paths that start the portal infrastructure pipeline when changed on `main`.
 *
 * `lib/portal/infra/**` holds the hosting stack shared by every frontend (buckets, CloudFront,
 * DNS, env config Lambda), so it must be included. The per-app folders (`lib/portal/orcaui/**`,
 * `lib/portal/hub/**`, ...) only contain app CI/CD pipeline stacks, which are deployed separately,
 * so they are deliberately NOT matched here: an app pipeline change must not redeploy shared
 * hosting infrastructure.
 */
export const PORTAL_INFRASTRUCTURE_FILE_PATHS = [
  'bin/**',
  'lib/common/**',
  'lib/portal/infra/**',
  'cdk.json',
  'package.json',
  'pnpm-lock.yaml',
  'tsconfig.json',
];

/**
 * Documentation-only paths that must NOT start the portal infrastructure pipeline.
 * These never affect a synthesized template, so a docs-only change shouldn't deploy.
 * Excludes win over includes, so e.g. `docs/**` here overrides an included folder's `README`.
 */
export const INFRASTRUCTURE_EXCLUDED_FILE_PATHS = [
  'docs/**',
  '**/*.md',
  '**/README*',
  'LICENSE',
  '**/LICENSE',
];

/**
 * Self-mutating pipeline that deploys the shared portal hosting stack to every stage.
 *
 * The `OrcaUI*` physical names below predate Hub and OrcaHouse joining the same distribution.
 * They are deployed resource identities, so they stay as-is: renaming them would replace the
 * pipeline and the hosting stack. See "Conventions" in the repository README.
 */
export class InfrastructureDeploymentStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    // Pin pnpm to the version in package.json's `packageManager` field. `corepack enable`
    // alone does not pin a version, so the CodeBuild agent's corepack would otherwise download
    // whatever pnpm it defaults to (observed: pnpm 12), which can mismatch the committed
    // lockfile format. `corepack prepare --activate` makes the version deterministic.
    const PNPM_VERSION = '10.34.5';
    const deployInstallCommands = [
      'node -v',
      'corepack enable',
      `corepack prepare pnpm@${PNPM_VERSION} --activate`,
      'pnpm --version',
      'pnpm install --frozen-lockfile',
    ];

    new DeploymentStackPipeline(this, 'DeploymentPipeline', {
      githubBranch: 'main',
      // Migration from orcabus to umccr org. See docs/migration-from-orca-ui.md.
      githubOwner: 'umccr',
      githubRepo: 'frontend-infrastructure-pipelines',
      includedFilePaths: PORTAL_INFRASTRUCTURE_FILE_PATHS,
      excludedFilePaths: INFRASTRUCTURE_EXCLUDED_FILE_PATHS,
      stack: InfrastructureStack,
      stackName: 'OrcaUIInfrastructureStack',
      stackConfig: {
        beta: getInfrastructureStackConfig(AppStage.BETA),
        gamma: getInfrastructureStackConfig(AppStage.GAMMA),
        prod: getInfrastructureStackConfig(AppStage.PROD),
      },
      pipelineName: 'OrcaBus-OrcaUIInfrastructure',
      synthInstallCommands: deployInstallCommands,
      cdkSynthCmd: ['pnpm cdk synth'],
      cdkOut: 'cdk.out',
      enableSlackNotification: true,
      unitIacTestConfig: {
        command: ['pnpm run test'],
        installCommands: deployInstallCommands,
      },
      unitAppTestConfig: {
        command: ['echo "Application tests are handled by the app deployment pipelines"'],
        installCommands: [],
      },
    });
  }
}

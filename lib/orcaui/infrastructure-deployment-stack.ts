import { Construct } from 'constructs';
import { DeploymentStackPipeline } from '@orcabus/platform-cdk-constructs/deployment-stack-pipeline';
import { InfrastructureStack } from './infrastructure-stack';
import { AppStage } from '../common/config';
import { getInfrastructureStackConfig } from './config';
import { Stack, StackProps } from 'aws-cdk-lib';

/**
 * Repository paths that start the OrcaUI infrastructure pipeline when changed on `main`.
 * Shared files are included because they affect every frontend; other frontends' folders are not.
 */
export const ORCAUI_INFRASTRUCTURE_FILE_PATHS = [
  'bin/**',
  'lib/common/**',
  'lib/orcaui/**',
  'cdk.json',
  'package.json',
  'pnpm-lock.yaml',
  'tsconfig.json',
];

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
      includedFilePaths: ORCAUI_INFRASTRUCTURE_FILE_PATHS,
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

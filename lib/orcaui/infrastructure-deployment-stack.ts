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
  'yarn.lock',
  '.yarnrc.yml',
  'tsconfig.json',
];

export class InfrastructureDeploymentStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    const deployInstallCommands = [
      'node -v',
      'corepack enable',
      'yarn --version',
      'yarn install --immutable',
    ];

    new DeploymentStackPipeline(this, 'DeploymentPipeline', {
      githubBranch: 'main',
      // TODO: this repository lives at `umccr/frontend-infrastructure-pipelines`, but
      // DeploymentStackPipeline always sources from `OrcaBus/<githubRepo>`. Before cutover, either add a
      // GitHub owner option upstream in @orcabus/platform-cdk-constructs or move this repository into
      // the OrcaBus organisation. See docs/migration-from-orca-ui.md.
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
      cdkSynthCmd: ['yarn cdk synth'],
      cdkOut: 'cdk.out',
      enableSlackNotification: true,
      unitIacTestConfig: {
        command: ['yarn run test'],
        installCommands: deployInstallCommands,
      },
      unitAppTestConfig: {
        command: ['echo "Application tests are handled by the app deployment pipelines"'],
        installCommands: [],
      },
    });
  }
}

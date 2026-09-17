import { App, Stack, StackProps } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { describe, expect, test } from '@jest/globals';
import { AppStage } from '../../lib/common/config';
import { HUB_APP, ORCAHOUSE_APP, PortalApp } from '../../lib/portal/apps';
import { HubAppPipelineStack } from '../../lib/hub/app-pipeline-stack';
import { OrcaHouseAppPipelineStack } from '../../lib/orcahouse/app-pipeline-stack';
import {
  acknowledgeFindings,
  addAwsSolutionsChecks,
  expectNoUnacknowledgedFindings,
} from '../common/cdk-nag-helpers';

// AwsSolutions findings accepted for the app CI/CD pipeline stacks.
const ACCEPTED_PIPELINE_RULES = [
  'AwsSolutions-IAM4',
  'AwsSolutions-IAM5',
  'AwsSolutions-S1',
  'AwsSolutions-KMS5',
  'AwsSolutions-CB3',
  'AwsSolutions-CB4',
];

/** Never-cache set the construct applies to every app, mirroring NEVER_CACHE_GLOBS. */
const BASE_NEVER_CACHE_GLOBS = [
  'index.html',
  '*/index.html',
  '404.html',
  'robots.txt',
  'manifest.json',
  '*.webmanifest',
  '*.ico',
];

type PipelineStackConstructor = new (scope: App, id: string, props: StackProps) => Stack;
type PipelineAction = { Name: string; ActionTypeId?: { Category?: string } };
type PipelineStage = { Name: string; Actions: PipelineAction[] };
type CodeBuildProject = {
  Name?: string;
  Source: { BuildSpec?: string };
  Environment?: { EnvironmentVariables?: Array<{ Name?: string; Value?: unknown }> };
};

const cases: {
  label: string;
  StackClass: PipelineStackConstructor;
  app: PortalApp;
  pipelineName: string;
  namePrefix: string;
  repo: string;
  artifactBaseDirectory: string;
  neverCacheGlobs: string[];
}[] = [
  {
    label: 'Hub',
    StackClass: HubAppPipelineStack,
    app: HUB_APP,
    pipelineName: 'HubAppCICDPipeline',
    namePrefix: 'Hub',
    repo: 'umccr/hub',
    artifactBaseDirectory: 'build/',
    neverCacheGlobs: BASE_NEVER_CACHE_GLOBS,
  },
  {
    label: 'OrcaHouse',
    StackClass: OrcaHouseAppPipelineStack,
    app: ORCAHOUSE_APP,
    pipelineName: 'OrcaHouseAppCICDPipeline',
    namePrefix: 'OrcaHouse',
    repo: 'umccr/orcahouse-ui',
    // Next.js static export, NOT .next/, which is a build cache and cannot be served from S3.
    artifactBaseDirectory: 'out/',
    neverCacheGlobs: [...BASE_NEVER_CACHE_GLOBS, '*.txt'],
  },
];

const projectsByName = (template: Template): Record<string, CodeBuildProject> =>
  Object.values(template.findResources('AWS::CodeBuild::Project')).reduce(
    (acc, resource) => {
      const properties = (resource as { Properties: CodeBuildProject }).Properties;
      if (typeof properties.Name === 'string') {
        acc[properties.Name] = properties;
      }
      return acc;
    },
    {} as Record<string, CodeBuildProject>
  );

const pipelineStages = (template: Template): PipelineStage[] => {
  const pipelines = Object.values(template.findResources('AWS::CodePipeline::Pipeline'));
  expect(pipelines).toHaveLength(1);
  return (pipelines[0] as { Properties: { Stages: PipelineStage[] } }).Properties.Stages;
};

/** Build-phase commands of a deploy project, decoded from the buildspec JSON. */
const deployCommands = (template: Template, projectName: string): string[] => {
  const project = projectsByName(template)[projectName];
  expect(project).toBeDefined();
  const buildSpec = JSON.parse(project.Source.BuildSpec!) as {
    phases: { build: { commands: string[] } };
  };
  return buildSpec.phases.build.commands;
};

/** Values passed to every `--include` or `--exclude` in one command, sorted for comparison. */
const globArgs = (command: string, flag: 'include' | 'exclude'): string[] =>
  [...command.matchAll(new RegExp(`--${flag} "([^"]+)"`, 'g'))].map((match) => match[1]).sort();

const sorted = (globs: string[]): string[] => [...globs].sort();

const envVar = (project: CodeBuildProject, name: string): unknown =>
  (project.Environment?.EnvironmentVariables ?? []).find((variable) => variable.Name === name)
    ?.Value;

describe.each(cases)(
  '$label app pipeline',
  ({
    label,
    StackClass,
    app,
    pipelineName,
    namePrefix,
    repo,
    artifactBaseDirectory,
    neverCacheGlobs,
  }) => {
    const nagApp = new App({});
    const nagStack = new StackClass(nagApp, `Test${label}AppPipeline`, {
      env: { account: '123456789012', region: 'ap-southeast-2' },
    });
    addAwsSolutionsChecks(nagStack);
    acknowledgeFindings(nagStack, ACCEPTED_PIPELINE_RULES, 'Allow CodePipeline defaults');

    const template = Template.fromStack(nagStack);

    test('cdk-nag AwsSolutions Pack reports no unacknowledged findings', () => {
      expect(() => expectNoUnacknowledgedFindings(nagApp)).not.toThrow();
    });

    test('sources the app repo from main', () => {
      const source = pipelineStages(template)[0];

      expect(source.Name).toBe('Source');
      Template.fromStack(nagStack).hasResourceProperties('AWS::CodePipeline::Pipeline', {
        Name: pipelineName,
      });
      expect(
        (source.Actions[0] as unknown as { Configuration: Record<string, unknown> }).Configuration
      ).toMatchObject({ FullRepositoryId: repo, BranchName: 'main' });
    });

    test('has a deploy stage for every configured stage and none for the others', () => {
      const stageNames = pipelineStages(template).map((stage) => stage.Name);
      const configured = Object.values(AppStage).filter((appStage) => app.bucketName[appStage]);

      expect(configured).toEqual([AppStage.BETA, AppStage.PROD]);
      expect(stageNames).toEqual([
        'Source',
        'Build',
        'DeployToBeta',
        'DeployToProdApproval',
        'DeployToProd',
      ]);
      // No staging soak is configured for these apps, so there must be no gamma stage at all
      // rather than one pointing at a bucket that does not exist.
      expect(stageNames).not.toContain('DeployToGamma');
    });

    test('requires manual approval immediately before prod', () => {
      const stages = pipelineStages(template);
      const prodIndex = stages.findIndex((stage) => stage.Name === 'DeployToProd');
      const approval = stages[prodIndex - 1];

      expect(prodIndex).toBeGreaterThan(0);
      expect(approval.Name).toBe('DeployToProdApproval');
      expect(approval.Actions[0].ActionTypeId?.Category).toBe('Approval');
    });

    test('publishes the framework build directory, not a build cache', () => {
      const buildSpec = projectsByName(template)[`${namePrefix}BuildProject`].Source.BuildSpec!;

      expect(buildSpec).toContain(`"base-directory": "${artifactBaseDirectory}"`);
      expect(buildSpec).toContain('"pnpm install --frozen-lockfile"');
      expect(buildSpec).toContain('"pnpm build"');
      expect(buildSpec).not.toContain('.next/');
    });

    test('installs the pnpm version the app pins, on a pinned Node', () => {
      const buildSpec = projectsByName(template)[`${namePrefix}BuildProject`].Source.BuildSpec!;

      // `corepack enable` only installs the shims; `corepack install` resolves the app's own
      // packageManager field, so the portal repo never duplicates each app's pnpm version.
      expect(buildSpec).toContain('"corepack enable"');
      expect(buildSpec).toContain('"corepack install"');
      // Logged so a resolved-version mismatch is visible when an install starts failing.
      expect(buildSpec).toContain('"pnpm --version"');
      expect(buildSpec).toContain('"nodejs": 24');
    });

    test.each([AppStage.BETA, AppStage.PROD])(
      '%s deploy targets the app path prefix',
      (appStage) => {
        const label2 = appStage === AppStage.BETA ? 'Beta' : 'Prod';
        const project = projectsByName(template)[`${namePrefix}DeployProject${label2}`];

        expect(project).toBeDefined();
        expect(envVar(project, 'DESTINATION_PATH')).toBe(
          `${app.bucketName[appStage]!}/${app.pathPrefix}/`
        );
        expect(envVar(project, 'PORTAL_APP_ID')).toBe(app.id);
      }
    );

    test.each([AppStage.BETA, AppStage.PROD])(
      '%s deploy caches immutably, never caches the shell, and leaves env.js alone',
      (appStage) => {
        const label2 = appStage === AppStage.BETA ? 'Beta' : 'Prod';
        const buildSpec =
          projectsByName(template)[`${namePrefix}DeployProject${label2}`].Source.BuildSpec!;

        // Pass one: everything hashed, cached for a year, with --delete pruning old builds.
        expect(buildSpec).toContain('--cache-control \\"public,max-age=31536000,immutable\\"');
        expect(buildSpec).toContain('--delete');
        // Pass two: the shell revalidates every request, so a pruned chunk cannot break a session.
        expect(buildSpec).toContain('--cache-control \\"no-cache\\"');

        // Anything excluded from pass one must be included in pass two or it is never uploaded.
        for (const glob of neverCacheGlobs) {
          expect(buildSpec).toContain(`--exclude \\"${glob}\\"`);
          expect(buildSpec).toContain(`--include \\"${glob}\\"`);
        }

        // env.js is written by the config Lambda, so it is excluded from both passes: --delete would
        // otherwise remove the live config before the Lambda rewrites it.
        expect(buildSpec).toContain('--exclude \\"env.js\\"');
        expect(buildSpec).not.toContain('--include \\"env.js\\"');

        // Source maps must not reach a public bucket at all, so unlike the never-cache globs they
        // are excluded from pass one and NOT re-added by pass two.
        expect(buildSpec).toContain('--exclude \\"*.map\\"');
        expect(buildSpec).not.toContain('--include \\"*.map\\"');
      }
    );

    test.each([AppStage.BETA, AppStage.PROD])(
      '%s deploy uploads nothing that pass one held back for caching, and nothing more',
      (appStage) => {
        const label2 = appStage === AppStage.BETA ? 'Beta' : 'Prod';
        const syncs = deployCommands(template, `${namePrefix}DeployProject${label2}`).filter(
          (command) => command.includes('aws s3 sync')
        );

        expect(syncs).toHaveLength(2);
        const [immutablePass, noCachePass] = syncs;

        // Pass two must re-add exactly the never-cache set: a glob excluded from pass one and not
        // included in pass two would never be uploaded at all.
        expect(globArgs(noCachePass, 'include')).toEqual(sorted(neverCacheGlobs));
        // Pass one holds back exactly that set, plus what is deliberately never uploaded and what
        // the config Lambda owns.
        expect(globArgs(immutablePass, 'exclude')).toEqual(
          sorted([...neverCacheGlobs, '*.map', 'env.js', '*/env.js'])
        );
      }
    );

    test.each([AppStage.BETA, AppStage.PROD])(
      '%s deploy invokes the config Lambda for this app only and checks the response',
      (appStage) => {
        const label2 = appStage === AppStage.BETA ? 'Beta' : 'Prod';
        const buildSpec =
          projectsByName(template)[`${namePrefix}DeployProject${label2}`].Source.BuildSpec!;

        expect(buildSpec).toContain('aws lambda invoke');
        expect(buildSpec).toContain('${PORTAL_APP_ID}');
        // `aws lambda invoke` exits 0 even when the function failed, so the response is inspected.
        expect(buildSpec).toContain('invoke-result.json');
        expect(buildSpec).toContain("payload.get('statusCode') != 200");
        expect(buildSpec).toContain("meta.get('FunctionError')");
      }
    );

    test('deploy roles are assumable only by CodeBuild', () => {
      const roles = Object.entries(template.findResources('AWS::IAM::Role')).filter(([logicalId]) =>
        logicalId.includes('DeployProjectRole')
      );

      expect(roles.length).toBeGreaterThan(0);
      for (const [, role] of roles) {
        const statements =
          (
            role as {
              Properties?: {
                AssumeRolePolicyDocument?: { Statement?: Array<Record<string, unknown>> };
              };
            }
          ).Properties?.AssumeRolePolicyDocument?.Statement ?? [];

        expect(statements).toEqual([
          expect.objectContaining({
            Action: 'sts:AssumeRole',
            Principal: { Service: 'codebuild.amazonaws.com' },
          }),
        ]);
      }
    });

    test('no gamma pre-deploy check project is created', () => {
      expect(projectsByName(template)[`${namePrefix}GammaPreDeployProject`]).toBeUndefined();
    });
  }
);

describe('portal app pipelines do not collide', () => {
  test('Hub and OrcaHouse use distinct physical names', () => {
    const names = (StackClass: PipelineStackConstructor, id: string) => {
      const template = Template.fromStack(
        new StackClass(new App({}), id, {
          env: { account: '123456789012', region: 'ap-southeast-2' },
        })
      );
      return [
        ...Object.keys(projectsByName(template)),
        ...Object.values(template.findResources('AWS::CodePipeline::Pipeline')).map(
          (resource) => (resource as { Properties: { Name: string } }).Properties.Name
        ),
      ];
    };

    const hub = names(HubAppPipelineStack, 'H');
    const orcahouse = names(OrcaHouseAppPipelineStack, 'O');

    // CodeBuild and CodePipeline names are account-wide, shared with OrcaUI's existing pipelines.
    expect(hub.filter((name) => orcahouse.includes(name))).toEqual([]);
  });
});

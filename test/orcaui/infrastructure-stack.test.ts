import { App } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { describe, expect, test } from '@jest/globals';
import { accountIdAlias, AppStage } from '../../lib/common/config';
import { InfrastructureStack } from '../../lib/orcaui/infrastructure-stack';
import {
  getInfrastructureStackConfig,
  v2CloudFrontBucketNameConfig,
} from '../../lib/orcaui/config';
import {
  acknowledgeFindings,
  addAwsSolutionsChecks,
  expectNoUnacknowledgedFindings,
} from './cdk-nag-helpers';

type CfnResource = {
  Properties?: Record<string, unknown>;
};

type CloudFrontDistributionResource = {
  Properties: {
    DistributionConfig?: {
      CacheBehaviors?: Array<Record<string, unknown>>;
    };
  };
};

// AwsSolutions findings accepted for the OrcaUI InfrastructureStack.
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
    'Accepted for OrcaUI hosting infrastructure'
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

const configuredV2Stages = Object.values(AppStage)
  .filter((appStage) => v2CloudFrontBucketNameConfig[appStage])
  .map((appStage) => ({
    appStage,
    expectedBucketName: v2CloudFrontBucketNameConfig[appStage]!,
  }));

describe.each(configuredV2Stages)(
  '$appStage-stack-v2-enabled-behavior',
  ({ appStage, expectedBucketName }) => {
    const app: App = new App({});

    const stack = new InfrastructureStack(app, `${appStage}InfrastructureStack`, {
      env: {
        account: accountIdAlias[appStage],
        region: 'ap-southeast-2',
      },
      tags: {
        'umccr-org:Product': 'OrcaUI',
        'umccr-org:Creator': 'CDK',
      },
      ...getInfrastructureStackConfig(appStage),
    });

    test('synthesizes with /v2/* CloudFront behavior', () => {
      const template = Template.fromStack(stack);
      template.hasResourceProperties('AWS::CloudFront::Distribution', {
        DistributionConfig: Match.objectLike({
          CacheBehaviors: Match.arrayWith([
            Match.objectLike({
              PathPattern: '/v2/*',
            }),
          ]),
        }),
      });
    });

    test('synthesizes v2 S3 bucket', () => {
      const template = Template.fromStack(stack);
      template.hasResourceProperties('AWS::S3::Bucket', {
        BucketName: expectedBucketName,
      });
    });

    test('Lambda has V2_BUCKET_NAME environment variable set', () => {
      const template = Template.fromStack(stack);
      template.hasResourceProperties('AWS::Lambda::Function', {
        Environment: Match.objectLike({
          Variables: Match.objectLike({
            V2_BUCKET_NAME: expectedBucketName,
          }),
        }),
      });
    });
  }
);

describe('infrastructure-stack-v2-disabled-behavior', () => {
  const app: App = new App({});

  const stack = new InfrastructureStack(app, 'V2DisabledInfrastructureStack', {
    env: {
      account: accountIdAlias[AppStage.BETA],
      region: 'ap-southeast-2',
    },
    tags: {
      'umccr-org:Product': 'OrcaUI',
      'umccr-org:Creator': 'CDK',
    },
    cloudFrontBucketName: 'orcaui-cloudfront-v2-disabled-test',
    configLambdaName: 'CodeBuildEnvConfigLambdaV2DisabledTest',
    aliasDomainName: ['orcaui.disabled.test'],
    reactBuildEnvVariables: {},
  });

  test('does not synthesize a v2 S3 bucket or /v2/* CloudFront behavior', () => {
    const template = Template.fromStack(stack);
    const buckets = Object.values(template.findResources('AWS::S3::Bucket')) as CfnResource[];
    const distributions = Object.values(
      template.findResources('AWS::CloudFront::Distribution')
    ) as CloudFrontDistributionResource[];
    const cacheBehaviors = distributions[0]?.Properties.DistributionConfig?.CacheBehaviors ?? [];

    expect(
      buckets.some((bucket) => {
        const bucketName = bucket.Properties?.BucketName;
        return typeof bucketName === 'string' && bucketName.startsWith('orcaui-v2-cloudfront-');
      })
    ).toBe(false);

    expect(cacheBehaviors).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ PathPattern: '/v2/*' })])
    );
  });

  test('Lambda leaves V2_BUCKET_NAME empty', () => {
    const template = Template.fromStack(stack);
    template.hasResourceProperties('AWS::Lambda::Function', {
      Environment: Match.objectLike({
        Variables: Match.objectLike({
          V2_BUCKET_NAME: '',
        }),
      }),
    });
  });
});

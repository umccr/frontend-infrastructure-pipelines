#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { TOOLCHAIN_ACCOUNT_ID, REGION } from '../lib/common/config';
import { InfrastructureDeploymentStack } from '../lib/orcaui/infrastructure-deployment-stack';
import { OrcaUIAppPipelineStack } from '../lib/orcaui/app-pipeline-stack';
import { OrcaUIV2AppPipelineStack } from '../lib/orcaui/v2-app-pipeline-stack';

const app = new cdk.App();

// ---------------------------------------------------------------------------
// OrcaUI (https://github.com/OrcaBus/orca-ui, https://github.com/OrcaBus/orca-ui-v2)
// ---------------------------------------------------------------------------

new InfrastructureDeploymentStack(app, 'OrcaUIInfrastructurePipeline', {
  env: {
    account: TOOLCHAIN_ACCOUNT_ID,
    region: REGION,
  },
  tags: {
    'umccr-org:Stack': 'OrcaUIInfrastructurePipeline',
    'umccr-org:Product': 'OrcaUI',
  },
});

new OrcaUIAppPipelineStack(app, 'OrcaUIAppPipeline', {
  env: {
    account: TOOLCHAIN_ACCOUNT_ID,
    region: REGION,
  },
  tags: {
    'umccr-org:Stack': 'OrcaUIAppPipeline',
    'umccr-org:Product': 'OrcaUI',
  },
});

new OrcaUIV2AppPipelineStack(app, 'OrcaUIV2AppPipeline', {
  env: {
    account: TOOLCHAIN_ACCOUNT_ID,
    region: REGION,
  },
  tags: {
    'umccr-org:Stack': 'OrcaUIV2AppPipeline',
    'umccr-org:Product': 'OrcaUI',
  },
});

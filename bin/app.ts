#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { TOOLCHAIN_ACCOUNT_ID, REGION } from '../lib/common/config';
import { InfrastructureDeploymentStack } from '../lib/portal/infra/infrastructure-deployment-stack';
import { OrcaUIAppPipelineStack } from '../lib/portal/orcaui/app-pipeline-stack';
import { OrcaUIV2AppPipelineStack } from '../lib/portal/orcaui/v2-app-pipeline-stack';
import { HubAppPipelineStack } from '../lib/portal/hub/app-pipeline-stack';
import { OrcaHouseAppPipelineStack } from '../lib/portal/orcahouse/app-pipeline-stack';

const app = new cdk.App();

const toolchainEnv = {
  account: TOOLCHAIN_ACCOUNT_ID,
  region: REGION,
};

// ---------------------------------------------------------------------------
// Shared portal hosting infrastructure (portal.<stage>.umccr.org)
//
// One stack per stage owns the S3 buckets, CloudFront distribution, Route 53 aliases and env
// config Lambda for every app mounted on the portal domain. Apps are registered in
// lib/portal/infra/apps.ts. The 'OrcaUI' prefix in the stack ID is a deployed resource identity that
// predates Hub and OrcaHouse; do not rename it.
// ---------------------------------------------------------------------------

new InfrastructureDeploymentStack(app, 'OrcaUIInfrastructurePipeline', {
  env: toolchainEnv,
  tags: {
    'umccr-org:Stack': 'OrcaUIInfrastructurePipeline',
    'umccr-org:Product': 'OrcaUI',
  },
});

// ---------------------------------------------------------------------------
// OrcaUI — served at / and /v2/
// (https://github.com/OrcaBus/orca-ui, https://github.com/OrcaBus/orca-ui-v2)
// ---------------------------------------------------------------------------

new OrcaUIAppPipelineStack(app, 'OrcaUIAppPipeline', {
  env: toolchainEnv,
  tags: {
    'umccr-org:Stack': 'OrcaUIAppPipeline',
    'umccr-org:Product': 'OrcaUI',
  },
});

new OrcaUIV2AppPipelineStack(app, 'OrcaUIV2AppPipeline', {
  env: toolchainEnv,
  tags: {
    'umccr-org:Stack': 'OrcaUIV2AppPipeline',
    'umccr-org:Product': 'OrcaUI',
  },
});

// ---------------------------------------------------------------------------
// Hub — served at /hub/ (https://github.com/umccr/hub)
// ---------------------------------------------------------------------------

new HubAppPipelineStack(app, 'HubAppPipeline', {
  env: toolchainEnv,
  tags: {
    'umccr-org:Stack': 'HubAppPipeline',
    'umccr-org:Product': 'Hub',
  },
});

// ---------------------------------------------------------------------------
// OrcaHouse — served at /orcahouse/ (https://github.com/umccr/orcahouse-ui)
// ---------------------------------------------------------------------------

new OrcaHouseAppPipelineStack(app, 'OrcaHouseAppPipeline', {
  env: toolchainEnv,
  tags: {
    'umccr-org:Stack': 'OrcaHouseAppPipeline',
    'umccr-org:Product': 'OrcaHouse',
  },
});

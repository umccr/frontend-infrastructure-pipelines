import { AppStage } from '../common/config';
import { getHostedApps } from './apps';
import { InfrastructureStackProps } from './infrastructure-stack';

/**
 * Per-stage configuration for the shared portal hosting stack.
 *
 * Bucket names are not listed here: they live in `apps.ts` so that the hosting stack and each
 * app's pipeline read the same value. See `PORTAL_APPS`.
 */

/** Hostnames the shared CloudFront distribution answers on, per stage. */
export const portalDomainNamesConfig: Record<AppStage, string[]> = {
  // 'orcaui.*' is retained for backward compatibility during the migration to 'portal.*'.
  [AppStage.BETA]: ['orcaui.dev.umccr.org', 'portal.dev.umccr.org'],
  [AppStage.GAMMA]: ['orcaui.stg.umccr.org', 'portal.stg.umccr.org'],
  [AppStage.PROD]: [
    'orcaui.umccr.org',
    'orcaui.prod.umccr.org',
    'portal.umccr.org',
    'portal.prod.umccr.org',
  ],
};

/**
 * Env config Lambda name, per stage. One Lambda per stage serves every portal app: it writes
 * `env.js` and invalidates the shared distribution.
 *
 * Do not rename. App deploy pipelines invoke these by name and the names are baked into
 * already-deployed CodeBuild projects.
 */
export const configLambdaNameConfig: Record<AppStage, string> = {
  [AppStage.BETA]: 'CodeBuildEnvConfigLambdaBeta',
  [AppStage.GAMMA]: 'CodeBuildEnvConfigLambdaGamma',
  [AppStage.PROD]: 'CodeBuildEnvConfigLambdaProd',
};

/** Backend API endpoints handed to the frontends via `env.js`, per stage. */
const reactBuildEnvVariablesConfig: Record<AppStage, Record<string, string>> = {
  [AppStage.BETA]: {
    VITE_METADATA_URL: 'https://metadata.dev.umccr.org',
    VITE_WORKFLOW_URL: 'https://workflow.dev.umccr.org',
    VITE_SEQUENCE_RUN_URL: 'https://sequence.dev.umccr.org',
    VITE_FILE_URL: 'https://file.dev.umccr.org',
    VITE_SSCHECK_URL: 'https://sscheck-orcabus.dev.umccr.org',
    VITE_HTSGET_URL: 'https://htsget-file.dev.umccr.org',
    VITE_CASE_URL: 'https://case.dev.umccr.org',
    VITE_SYSTEM_CATALOG_URL: 'https://system-catalog.dev.umccr.org',
    VITE_DEPLOY_STATUS_URL: 'https://deploy-status.dev.umccr.org',
  },
  [AppStage.GAMMA]: {
    VITE_METADATA_URL: 'https://metadata.stg.umccr.org',
    VITE_WORKFLOW_URL: 'https://workflow.stg.umccr.org',
    VITE_SEQUENCE_RUN_URL: 'https://sequence.stg.umccr.org',
    VITE_FILE_URL: 'https://file.stg.umccr.org',
    VITE_SSCHECK_URL: 'https://sscheck-orcabus.stg.umccr.org',
    VITE_CASE_URL: 'https://case.stg.umccr.org',
    VITE_SYSTEM_CATALOG_URL: 'https://system-catalog.stg.umccr.org',
    VITE_DEPLOY_STATUS_URL: 'https://deploy-status.stg.umccr.org',
  },
  [AppStage.PROD]: {
    VITE_METADATA_URL: 'https://metadata.prod.umccr.org',
    VITE_WORKFLOW_URL: 'https://workflow.prod.umccr.org',
    VITE_SEQUENCE_RUN_URL: 'https://sequence.prod.umccr.org',
    VITE_FILE_URL: 'https://file.prod.umccr.org',
    VITE_SSCHECK_URL: 'https://sscheck-orcabus.prod.umccr.org',
    VITE_CASE_URL: 'https://case.prod.umccr.org',
    VITE_SYSTEM_CATALOG_URL: 'https://system-catalog.prod.umccr.org',
    VITE_DEPLOY_STATUS_URL: 'https://deploy-status.prod.umccr.org',
  },
};

export const getInfrastructureStackConfig = (appStage: AppStage): InfrastructureStackProps => ({
  hostedApps: getHostedApps(appStage),
  configLambdaName: configLambdaNameConfig[appStage],
  aliasDomainName: portalDomainNamesConfig[appStage],
  reactBuildEnvVariables: reactBuildEnvVariablesConfig[appStage],
});

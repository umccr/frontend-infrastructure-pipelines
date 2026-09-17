import { accountIdAlias, AppStage } from '../common/config';

/**
 * Registry of the frontends hosted on the shared portal distribution
 * (`portal.<stage>.umccr.org`).
 *
 * Each app is an independently built and deployed SPA, served in place on its own URL path prefix
 * of the same hostname, from its own S3 bucket, behind one shared CloudFront distribution. There
 * is no HTTP redirect and no shared runtime shell: navigating between apps is a full page load.
 *
 * `pathPrefix` is the contract shared by three places, all of which derive it from this file:
 *
 *  1. `infrastructure-stack.ts` — a CloudFront behaviour per prefix, and the SPA rewrite allowlist.
 *  2. `lambda/env_config_and_cdn_refresh.py` — writes `<prefix>/env.js` into the app's bucket.
 *  3. `lib/<app>/app-pipeline-stack.ts` — syncs the build artifact to `s3://<bucket>/<prefix>/`.
 *
 * Adding an app here does not deploy it. It becomes real once a stage has a bucket name, and
 * reachable once its pipeline stack is registered in `bin/app.ts`.
 *
 * See `docs/portal/future-improvements.md` for the deferred work on this design.
 */
/**
 * How an app's build output maps URLs to files, which decides how the CloudFront viewer-request
 * function rewrites a client-side route.
 *
 * - `spa`: the build emits one `index.html` shell and the client router handles every route, so any
 *   route rewrites to `<prefix>/index.html`. Vite and CRA single-page builds.
 * - `static-export`: the build emits one HTML file per route in directory form
 *   (`dashboard/index.html`), so a route rewrites to `<route>/index.html` rather than to the shell.
 *   Next.js `output: 'export'` with `trailingSlash: true`.
 *
 * Getting this wrong is silent: an SPA fallback applied to a static export serves the app's home
 * page for every deep link instead of the requested page.
 */
export type ClientRouting = 'spa' | 'static-export';

export interface PortalApp {
  /**
   * Stable identifier. Used to derive CDK construct IDs, so treat it as immutable:
   * changing it after deployment replaces the underlying resources.
   */
  readonly id: string;

  /**
   * URL path prefix without leading or trailing slashes. An empty string means the app is served
   * from the site root (`/`) as the CloudFront default behaviour. Exactly one app may be the root.
   *
   * The app's build must be configured with this as its base path, or its asset URLs resolve
   * against the root app's bucket instead of its own. Vite `base`, Next.js `basePath`.
   */
  readonly pathPrefix: string;

  /** GitHub `owner/repo` the app is built from. */
  readonly repo: string;

  /** How the build output maps URLs to files. See {@link ClientRouting}. */
  readonly clientRouting: ClientRouting;

  /**
   * Per-stage S3 bucket holding the built assets. A stage left `undefined` is not provisioned:
   * the hosting stack omits the bucket, the CloudFront behaviour and the SPA rewrite entry, and
   * the app pipeline omits the deploy stage. This is how a new app rolls out beta first.
   */
  readonly bucketName: Partial<Record<AppStage, string>>;
}

/**
 * Bucket naming convention shared by every portal app: `<app>-cloudfront-<account-id>`.
 * Derived from `accountIdAlias` so a stage cannot silently get the wrong account's bucket.
 */
const cloudFrontBucketName = (app: string, appStage: AppStage): string =>
  `${app}-cloudfront-${accountIdAlias[appStage]}`;

const allStages = (app: string): Record<AppStage, string> => ({
  [AppStage.BETA]: cloudFrontBucketName(app, AppStage.BETA),
  [AppStage.GAMMA]: cloudFrontBucketName(app, AppStage.GAMMA),
  [AppStage.PROD]: cloudFrontBucketName(app, AppStage.PROD),
});

/**
 * OrcaUI — served from the site root.
 *
 * Root ownership means every unmatched path falls through to OrcaUI, and that `/env.js`,
 * `/favicon.ico` and `/robots.txt` live in OrcaUI's bucket. Kept as-is deliberately: existing users
 * and bookmarks depend on `portal.umccr.org` loading OrcaUI. The planned move to `/orcaui/` is
 * tracked in `docs/portal/future-improvements.md`.
 */
export const ORCAUI_APP: PortalApp = {
  id: 'orcaui',
  pathPrefix: '',
  repo: 'OrcaBus/orca-ui',
  clientRouting: 'spa',
  bucketName: allStages('orcaui'),
};

/** OrcaUI v2 — served from `/v2/`. */
export const ORCAUI_V2_APP: PortalApp = {
  id: 'orcaui-v2',
  pathPrefix: 'v2',
  repo: 'OrcaBus/orca-ui-v2',
  clientRouting: 'spa',
  bucketName: allStages('orcaui-v2'),
};

/**
 * Hub — served from `/hub/`. React SPA built with pnpm.
 *
 * Requires in `umccr/hub`: the bundler's base path set to `/hub/` (Vite `base`), or its asset URLs
 * resolve against the root app's bucket.
 *
 * Beta and prod only; there is deliberately no gamma. See the note on GAMMA_GAP_APPS below.
 */
export const HUB_APP: PortalApp = {
  id: 'hub',
  pathPrefix: 'hub',
  repo: 'umccr/hub',
  clientRouting: 'spa',
  bucketName: {
    [AppStage.BETA]: cloudFrontBucketName('hub', AppStage.BETA),
    [AppStage.PROD]: cloudFrontBucketName('hub', AppStage.PROD),
  },
};

/**
 * OrcaHouse — served from `/orcahouse/`. Next.js built with pnpm.
 *
 * Requires in `umccr/orcahouse-ui`:
 *  - `output: 'export'` in `next.config`, so the build emits a static site in `out/`. The default
 *    `.next/` directory is a build cache and cannot be served from S3. This rules out SSR, API
 *    routes, middleware and ISR; if OrcaHouse needs any of those, it cannot be hosted here.
 *  - `trailingSlash: true`, so each route exports as `<route>/index.html`, matching
 *    `clientRouting: 'static-export'`.
 *  - `basePath: '/orcahouse'` and a matching `assetPrefix`, or its `/_next/...` requests resolve
 *    against the root app's bucket.
 *
 * Beta and prod only; there is deliberately no gamma. See the note on GAMMA_GAP_APPS below.
 */
export const ORCAHOUSE_APP: PortalApp = {
  id: 'orcahouse',
  pathPrefix: 'orcahouse',
  repo: 'umccr/orcahouse-ui',
  clientRouting: 'static-export',
  bucketName: {
    [AppStage.BETA]: cloudFrontBucketName('orcahouse', AppStage.BETA),
    [AppStage.PROD]: cloudFrontBucketName('orcahouse', AppStage.PROD),
  },
};

/**
 * Every app hosted on the portal distribution.
 *
 * Order is significant for CDK construct creation order, which keeps synthesized templates stable.
 * **Append new apps at the end**; reordering produces a large, meaningless template diff.
 */
export const PORTAL_APPS: PortalApp[] = [ORCAUI_APP, ORCAUI_V2_APP, HUB_APP, ORCAHOUSE_APP];

/**
 * Apps hosted in prod but not gamma, so their changes reach production without a staging soak.
 *
 * This is a deliberate trade for delivery speed, recorded here rather than left implicit. The
 * consequence: a `lib/portal/**` change that affects these apps is first exercised against them in
 * production, and their own app pipelines promote beta straight to prod behind a manual approval.
 * Add the gamma bucket to close the gap.
 */
export const GAMMA_GAP_APPS: PortalApp[] = PORTAL_APPS.filter(
  (app) => app.bucketName[AppStage.PROD] && !app.bucketName[AppStage.GAMMA]
);

/** An app resolved for one stage: bucket known, so the hosting stack needs no stage awareness. */
export interface HostedApp {
  readonly id: string;
  readonly pathPrefix: string;
  readonly clientRouting: ClientRouting;
  readonly bucketName: string;
}

/**
 * Apps actually hosted in `appStage`, in registry order. Throws if the registry does not describe
 * exactly one root app for the stage, because CloudFront needs precisely one default behaviour.
 */
export const getHostedApps = (appStage: AppStage): HostedApp[] => {
  const hostedApps = PORTAL_APPS.filter((app) => app.bucketName[appStage]).map((app) => ({
    id: app.id,
    pathPrefix: app.pathPrefix,
    clientRouting: app.clientRouting,
    bucketName: app.bucketName[appStage]!,
  }));

  const rootApps = hostedApps.filter((app) => app.pathPrefix === '');
  if (rootApps.length !== 1) {
    throw new Error(
      `Exactly one portal app must serve the site root in ${appStage}, found ${rootApps.length}` +
        (rootApps.length ? `: ${rootApps.map((app) => app.id).join(', ')}` : '')
    );
  }

  const duplicatePrefixes = hostedApps
    .map((app) => app.pathPrefix)
    .filter((prefix, index, prefixes) => prefixes.indexOf(prefix) !== index);
  if (duplicatePrefixes.length) {
    throw new Error(
      `Portal apps in ${appStage} share a path prefix: ${duplicatePrefixes.join(', ')}`
    );
  }

  return hostedApps;
};

/**
 * Bucket for `app` in `appStage`. Use in pipeline stacks, where a missing bucket is a
 * configuration error rather than an opt-out.
 */
export const requireBucketName = (app: PortalApp, appStage: AppStage): string => {
  const bucketName = app.bucketName[appStage];
  if (!bucketName) {
    throw new Error(`Portal app '${app.id}' has no CloudFront bucket configured for ${appStage}`);
  }
  return bucketName;
};

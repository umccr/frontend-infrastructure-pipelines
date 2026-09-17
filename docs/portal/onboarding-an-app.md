# Onboarding an app to the portal

What an app repository must do to be served from `portal.<stage>.umccr.org/<prefix>/`.

The infrastructure side is one registry entry; see
[Adding a new frontend](../../README.md#adding-a-new-frontend). This page covers the **app repo**
side, which is where onboarding usually goes wrong, because the failures are quiet: assets 404, or
deep links render the wrong page, rather than the deploy failing.

## 1. Build with the path prefix as the base path

Every app shares one hostname with the others. An app built for the site root emits asset URLs like
`/assets/main-abc123.js`, which resolve against the **root app's** bucket, not its own. The result is
a blank page with 404s in the console, or worse, OrcaUI's HTML served where a chunk was expected.

Set the base path to match `pathPrefix` in [`apps.ts`](../../lib/portal/apps.ts):

| Toolchain        | Setting                                                              |
| ---------------- | -------------------------------------------------------------------- |
| Vite             | `base: '/hub/'`                                                      |
| Create React App | `"homepage": "/hub/"` in `package.json`                              |
| Next.js          | `basePath: '/orcahouse'`, plus a matching `assetPrefix`              |
| Router (any)     | Router basename set to the same prefix, e.g. React Router `basename` |

The root app (`pathPrefix: ''`) needs none of this.

## 2. Emit a servable directory, and know which one it is

The pipeline syncs the **contents** of one directory to `s3://<bucket>/<prefix>/`, so that directory
must have `index.html` at its top level.

| App       | Toolchain     | Build        | Artifact directory |
| --------- | ------------- | ------------ | ------------------ |
| OrcaUI    | Yarn, Vite    | `yarn build` | `dist/`            |
| OrcaUI v2 | pnpm          | `pnpm build` | `build/`           |
| Hub       | pnpm, React   | `pnpm build` | `build/`           |
| OrcaHouse | pnpm, Next.js | `pnpm build` | `out/`             |

### Next.js needs a static export

`.next/` is a build cache, not a website. It has no top-level `index.html` and cannot be served from
S3. `next.config` must produce a static export:

```js
const nextConfig = {
  output: 'export', // emit a static site into out/
  trailingSlash: true, // export each route as <route>/index.html
  basePath: '/orcahouse',
  assetPrefix: '/orcahouse',
  images: { unoptimized: true }, // the Image Optimization API needs a server
};
```

`output: 'export'` **rules out SSR, API routes, middleware and ISR.** If the app needs any of them it
cannot be hosted on the portal distribution as-is; it needs a server runtime, which is a different
conversation from this repo.

## 3. Declare how routes map to files

`clientRouting` in the registry must match what the build emits, because the CloudFront function
rewrites URLs based on it. Getting it wrong is silent.

| `clientRouting` | Build emits                                 | `/orcahouse/tables` resolves to |
| --------------- | ------------------------------------------- | ------------------------------- |
| `spa`           | one `index.html`, client router handles all | `<prefix>/index.html`           |
| `static-export` | one HTML file per route, in directory form  | `/orcahouse/tables/index.html`  |

An SPA fallback applied to a static export serves the app's **home page** for every deep link. A
static-export rewrite applied to an SPA 404s every deep link. `trailingSlash: true` is what makes the
`static-export` mode correct for Next.js; without it the export emits `tables.html`, not
`tables/index.html`.

Routing behaviour is covered by [`test/portal/spa-rewrite.test.ts`](../../test/portal/spa-rewrite.test.ts),
which executes the generated function. Add cases there when onboarding an app.

## 4. Read runtime config from `env.js`

Config is not baked into the build. The env config Lambda writes `<prefix>/env.js` into the app's
bucket after every deploy, setting `window.config`. Load it before the app bundle:

```html
<script src="env.js"></script>
```

The path is relative, so each app gets its own copy. Consolidating to a single shared `/env.js` is
[future improvement 3](./future-improvements.md#3-serve-a-single-envjs-for-the-whole-portal).

**Do not commit an `env.js`** into the build output. The deploy excludes it from both sync passes so
the live one survives `--delete`; a build-provided copy would never be uploaded and could confuse
local development.

All apps currently receive the same payload, listed in
[`config.ts`](../../lib/portal/config.ts). Values sourced from SSM (Cognito client, OAuth
redirects) are shared, which is what makes single sign-on across the portal work.

## 5. Expect a shared session, and a shared trust boundary

All portal apps are on one browser origin, so they share cookies, `localStorage` and the Cognito
session. Two consequences:

- A user signed in to OrcaUI is signed in to Hub. This is the point of path-based hosting.
- Any app's XSS can read every other app's tokens. The four apps are one trust boundary.

Use the same token storage keys and refresh logic as the other apps rather than inventing your own,
or users will appear signed out when moving between apps.
[`@orcabus/portal-runtime`](./future-improvements.md#2-orcabusportal-runtime-shared-auth-and-config)
is the planned home for that shared code.

## 6. Know what caching the deploy applies, and what is dropped

The deploy uploads in two passes:

- Hashed asset filenames get `Cache-Control: public,max-age=31536000,immutable`.
- Stable, unhashed names get `Cache-Control: no-cache`: `index.html` at any depth, `404.html`,
  `robots.txt`, `manifest.json`, `*.webmanifest` and `*.ico`.

This matters because the sync runs with `--delete`, which prunes the previous build's chunks
immediately. If your build emits a file that is fetched by a **stable, unhashed** name and is not in
that list, add it via `additionalNeverCacheGlobs` on the pipeline, or clients will hold a stale copy
for a year. Next.js App Router `.txt` RSC payloads are the existing example.

Two categories never reach the bucket at all:

- **`*.map`.** A source map next to a bundle is publicly fetchable by name whether or not the bundle
  links to it, so `sourcemap: 'hidden'` does not make it private — only not uploading it does. If you
  want source maps for error reporting, upload them to the reporting service from CI instead.
- **`env.js`.** The config Lambda owns it. A placeholder in your build output is fine and is what you
  should use for local development; the deploy will not overwrite the real one with it.

## Checklist

- [ ] Base path set to the app's `pathPrefix`, in the bundler and the router.
- [ ] Build emits a servable directory with a top-level `index.html`; `artifactBaseDirectory` matches.
- [ ] Next.js only: `output: 'export'`, `trailingSlash: true`, no SSR / API routes / middleware / ISR.
- [ ] `clientRouting` matches what the build emits, with routing cases added to the test suite.
- [ ] `index.html` loads `env.js` relatively; no `env.js` committed in the build output.
- [ ] Auth uses the shared token storage and refresh behaviour.
- [ ] Any stable-named, unhashed build outputs declared in `additionalNeverCacheGlobs`.
- [ ] `packageManager` pinned in `package.json`, lockfile committed, `.nvmrc` present.
- [ ] Default branch is `main`, or `branch` is set on the pipeline.
- [ ] CI does not build after sourcing a script that exports `VITE_*` / `NEXT_PUBLIC_*` from a single
      environment, or those values get baked in as a silent fallback behind `env.js`.

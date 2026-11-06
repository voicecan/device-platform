import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('standalone connector image keeps the reviewed build and non-root runtime boundary', async () => {
  const dockerfile = await readFile(new URL('../Dockerfile', import.meta.url), 'utf8');
  const nginx = await readFile(new URL('../deploy/nginx.conf', import.meta.url), 'utf8');
  assert.match(dockerfile, /FROM node:24\.19\.0-bookworm-slim AS build/);
  assert.match(dockerfile, /COPY \.gitea \.\/\.gitea/);
  assert.match(dockerfile, /--mount=type=cache,target=\/root\/\.npm,sharing=locked/);
  assert.match(dockerfile, /npm run check:public/);
  assert.match(dockerfile, /npm run verify:core/);
  assert.match(dockerfile, /npm run typecheck/);
  assert.match(dockerfile, /npm run build --workspace @voicecan\/device-connect-web/);
  assert.match(dockerfile, /node --import tsx --test/);
  assert.match(dockerfile, /FROM nginx:1\.28\.0-alpine AS runtime/);
  assert.match(dockerfile, /USER 101:101/);
  assert.match(dockerfile, /chown -R nginx:nginx .* \/run /);
  assert.doesNotMatch(dockerfile, /chown -R nginx:nginx .* \/var\/run /);
  assert.match(dockerfile, /EXPOSE 8080/);
  assert.match(nginx, /Permissions-Policy "bluetooth=\(self\)/);
  assert.match(nginx, /Cross-Origin-Opener-Policy "unsafe-none"/);
  assert.match(nginx, /Cache-Control "no-store"/);
  assert.match(nginx, /trusted-types voicecan lit-html sanitizer/);
});

test('connector deployment template keeps parameterized images and a non-root runtime', async () => {
  const deployment = await readFile(new URL('../deploy/deploy.template', import.meta.url), 'utf8');
  assert.match(deployment, /kind: Service/);
  assert.match(deployment, /targetPort: 8080/);
  assert.match(deployment, /kind: Deployment/);
  assert.match(deployment, /runAsNonRoot: true/);
  assert.match(deployment, /runAsUser: 101/);
  assert.match(deployment, /runAsGroup: 101/);
  assert.match(deployment, /image: {{IMAGE_URL}}:{{IMAGE_TAG}}/);
});

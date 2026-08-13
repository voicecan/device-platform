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

test('Gitea connector workflow verifies, publishes amd64, and deploys', async () => {
  const workflow = await readFile(new URL('../../../.gitea/workflows/device-connect-web-image.yaml', import.meta.url), 'utf8');
  const deployment = await readFile(new URL('../deploy/deploy.template', import.meta.url), 'utf8');
  assert.match(workflow, /^\s{2}workflow_dispatch:\s*$/m);
  assert.match(workflow, /^\s{2}push:\s*$/m);
  assert.match(workflow, /- test/);
  assert.match(workflow, /-f packages\/device-connect-web\/Dockerfile/);
  assert.match(workflow, /--platform linux\/amd64/);
  assert.match(workflow, /--push/);
  assert.match(workflow, /kubectl apply/);
  assert.match(workflow, /kubectl rollout status/);
  assert.match(workflow, /nc -zv -w 5/);
  assert.match(workflow, /MTU validation over TCP/);
  assert.doesNotMatch(workflow, /timeout (?:30|210) ssh/);
  assert.doesNotMatch(workflow, /Setup Node\.js|Verify Device Connect Web|setup-node|npm ci|linux\/arm64|setup-qemu-action|type=oci|upload-artifact/);
  assert.match(deployment, /kind: Service/);
  assert.match(deployment, /targetPort: 8080/);
  assert.match(deployment, /kind: Deployment/);
  assert.match(deployment, /runAsNonRoot: true/);
  assert.match(deployment, /runAsUser: 101/);
  assert.match(deployment, /runAsGroup: 101/);
  assert.match(deployment, /image: {{IMAGE_URL}}:{{IMAGE_TAG}}/);
});

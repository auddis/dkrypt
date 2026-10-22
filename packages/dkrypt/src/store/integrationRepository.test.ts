import { createHmac, randomUUID } from 'node:crypto';
import { expect, test } from 'bun:test';
import { acceptIntegrationBillingOwnerTransfer, createSignedTriggerPolicy, finishIntegrationDelivery, getIntegrationDelivery, getSignedTriggerPolicy, mergeIntegrationBillingOwner, publicSignedTriggerPolicy, releaseIntegrationDelivery, requestIntegrationBillingOwnerTransfer, reserveIntegrationDelivery, revokeSignedTriggerPolicy, rotateSignedTriggerSecret, verifySignedTrigger } from '#store/integrationRepository.js';

test('signed trigger verification checks raw bytes, freshness, and rotated secrets', () => {
  const policy = createSignedTriggerPolicy({ projectId: randomUUID(), bundleIds: ['com.example.app'], sources: ['appstore'], createdBy: 'tester' });
  const rawBody = Buffer.from('{"bundleId":"com.example.app","source":"appstore"}');
  const timestamp = String(Date.now());
  const eventId = randomUUID();
  const sign = (secret: string, body = rawBody) => createHmac('sha256', secret).update(Buffer.concat([Buffer.from(`${timestamp}.${eventId}.`), body])).digest('hex');
  expect(verifySignedTrigger(policy, timestamp, eventId, sign(policy.secret), rawBody)).toBe(true);
  expect(verifySignedTrigger(policy, timestamp, eventId, sign(policy.secret), Buffer.from('{}'))).toBe(false);
  expect(verifySignedTrigger(policy, String(Date.now() - 6 * 60_000), eventId, sign(policy.secret), rawBody)).toBe(false);
  expect(JSON.stringify(publicSignedTriggerPolicy(policy))).not.toContain(policy.secret);
  const rotated = rotateSignedTriggerSecret(policy.id)!;
  expect(verifySignedTrigger(rotated, timestamp, eventId, sign(policy.secret), rawBody)).toBe(true);
  expect(verifySignedTrigger(rotated, timestamp, eventId, sign(rotated.secret), rawBody)).toBe(true);
  expect(revokeSignedTriggerPolicy(policy.id)).toBe(true);
  expect(verifySignedTrigger({ ...rotated, enabled: false }, timestamp, eventId, sign(rotated.secret), rawBody)).toBe(false);
});

test('signed trigger event IDs are persistently deduplicated', () => {
  const integrationId = randomUUID();
  const eventId = randomUUID();
  const delivery = reserveIntegrationDelivery(integrationId, eventId);
  expect(delivery?.status).toBe('processing');
  expect(reserveIntegrationDelivery(integrationId, eventId)).toBeUndefined();
  finishIntegrationDelivery(delivery!, 'accepted', 'job-1');
  expect(getIntegrationDelivery(integrationId, eventId)).toMatchObject({ status: 'accepted', jobId: 'job-1' });
});

test('a trigger rejected before queue admission releases its delivery reservation', () => {
  const integrationId = randomUUID();
  const eventId = randomUUID();
  const delivery = reserveIntegrationDelivery(integrationId, eventId)!;
  releaseIntegrationDelivery(delivery);
  expect(reserveIntegrationDelivery(integrationId, eventId)?.eventId).toBe(eventId);
});

test('automation owner transfer waits for recipient acceptance', () => {
  const created = createSignedTriggerPolicy({ projectId: randomUUID(), bundleIds: ['com.example.app'], sources: ['appstore'], createdBy: 'owner@example.test' });
  const requested = requestIntegrationBillingOwnerTransfer(created.id, 'recipient@example.test', 'admin@example.test');
  expect(requested?.billingOwnerId).toBe('owner@example.test');
  expect(requested?.billingOwnerTransfer?.userId).toBe('recipient@example.test');
  expect(acceptIntegrationBillingOwnerTransfer(created.id, 'other@example.test')).toBeUndefined();
  const accepted = acceptIntegrationBillingOwnerTransfer(created.id, 'recipient@example.test');
  expect(accepted?.billingOwnerId).toBe('recipient@example.test');
  expect(accepted?.billingOwnerTransfer).toBeUndefined();
  expect(getSignedTriggerPolicy(created.id)?.billingOwnerId).toBe('recipient@example.test');
  expect(requestIntegrationBillingOwnerTransfer(created.id, 'admin@example.test', 'admin@example.test')?.billingOwnerId).toBe('admin@example.test');
});

test('account merge transfers integration billing ownership and pending acceptance', () => {
  const policy = createSignedTriggerPolicy({ projectId: randomUUID(), bundleIds: ['com.example.merge'], sources: ['appstore'], createdBy: 'source@example.test' });
  requestIntegrationBillingOwnerTransfer(policy.id, 'pending@example.test', 'source@example.test');
  mergeIntegrationBillingOwner('target@example.test', 'source@example.test');
  const merged = getSignedTriggerPolicy(policy.id)!;
  expect(merged.billingOwnerId).toBe('target@example.test');
  expect(merged.billingOwnerTransfer?.requestedBy).toBe('target@example.test');
  expect(acceptIntegrationBillingOwnerTransfer(policy.id, 'pending@example.test')?.billingOwnerId).toBe('pending@example.test');
});

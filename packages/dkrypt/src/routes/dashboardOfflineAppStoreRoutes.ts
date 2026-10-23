import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import { Type } from '@sinclair/typebox';
import { authenticateAppleAccount, getOfflineAppStoreReadiness, OfflineAppStoreAuthenticationError } from '#offlineAppStore.js';
import { clearAppleAccountCredentials, saveAppleAccountCredentials, saveAppleAccountFairPlayCredential } from '#appleAccountVault.js';
import { PermissionFlag } from '#permissions.js';
import { fastifyRequirePermission, fastifyRequireRecentAuthentication, fastifyRequireSession, getFastifySession } from '#session.js';
import { recordAudit } from '#store/state.js';
import { createHttpErrorEnvelope } from '#util/httpResponse.js';
import { getFairPlayCredentialRetrievalStatus, startFairPlayCredentialRetrieval } from '#offlineAppStoreCredential.js';
import type { CredentialRetrievalStatus } from '#offlineAppStoreCredential.js';

interface DashboardOfflineAppStoreServices {
  readiness: typeof getOfflineAppStoreReadiness;
  saveAccount: typeof saveAppleAccountCredentials;
  saveCredential: typeof saveAppleAccountFairPlayCredential;
  authenticate: typeof authenticateAppleAccount;
  getCredentialRetrievalStatus: typeof getFairPlayCredentialRetrievalStatus;
  retrieveCredential: typeof startFairPlayCredentialRetrieval;
  clear: typeof clearAppleAccountCredentials;
}

const defaultServices: DashboardOfflineAppStoreServices = {
  readiness: getOfflineAppStoreReadiness,
  saveAccount: saveAppleAccountCredentials,
  saveCredential: saveAppleAccountFairPlayCredential,
  authenticate: authenticateAppleAccount,
  getCredentialRetrievalStatus: getFairPlayCredentialRetrievalStatus,
  retrieveCredential: startFairPlayCredentialRetrieval,
  clear: clearAppleAccountCredentials,
};

export function createDashboardOfflineAppStoreRoutes(overrides: Partial<DashboardOfflineAppStoreServices> = {}): FastifyPluginAsyncTypebox {
  const services = { ...defaultServices, ...overrides };
  return async (server) => {
    server.addHook('preHandler', fastifyRequireSession);
    const administrator = fastifyRequirePermission(PermissionFlag.administrator);
    const reauthenticatedAdministrator = [administrator, fastifyRequireRecentAuthentication()];

    server.get('/v1/dashboard/appstore-offline/status', {
      schema: { hide: true },
      preHandler: administrator,
    }, () => ({ ...services.readiness(), credentialRetrieval: services.getCredentialRetrievalStatus() }));

    server.post('/v1/dashboard/appstore-offline/credential/retrieve', {
      schema: { hide: true, body: Type.Object({ deviceId: Type.String({ minLength: 1, maxLength: 128 }) }, { additionalProperties: false }) },
      preHandler: reauthenticatedAdministrator,
    }, (request, reply) => {
      try {
        const previousOperationId = services.getCredentialRetrievalStatus().operationId;
        const retrieval = services.retrieveCredential(request.body.deviceId);
        if (retrieval.state === 'running' && retrieval.operationId !== previousOperationId) {
          recordAudit(getFastifySession(request)!.sub, 'settings.update', 'appstore-offline-credential', `FairPlay credential retrieval started for device ${request.body.deviceId}`);
        }
        return reply.code(202).send({ ...services.readiness(), credentialRetrieval: retrieval as CredentialRetrievalStatus });
      } catch (error) {
        return reply.code(409).send(createHttpErrorEnvelope(request.id, 409, error instanceof Error ? error.message : 'Could not start FairPlay credential retrieval'));
      }
    });

    server.put('/v1/dashboard/appstore-offline/account', {
      schema: { hide: true, body: Type.Object({ appleId: Type.String({ minLength: 3, maxLength: 320, format: 'email' }), password: Type.String({ minLength: 1, maxLength: 1024 }) }, { additionalProperties: false }) },
      preHandler: reauthenticatedAdministrator,
    }, (request, reply) => {
      try {
        services.saveAccount(request.body.appleId, request.body.password);
        recordAudit(getFastifySession(request)!.sub, 'settings.update', 'appstore-offline-account', 'Apple Account credentials updated');
        return services.readiness();
      } catch (error) {
        return reply.code(409).send(createHttpErrorEnvelope(request.id, 409, error instanceof Error ? error.message : 'Could not save Apple Account credentials'));
      }
    });

    server.post('/v1/dashboard/appstore-offline/authenticate', {
      schema: { hide: true, body: Type.Object({ verificationCode: Type.Optional(Type.String({ pattern: '^\\d{6}$' })) }, { additionalProperties: false }) },
      preHandler: reauthenticatedAdministrator,
    }, async (request, reply) => {
      try {
        await services.authenticate(request.body.verificationCode);
        recordAudit(getFastifySession(request)!.sub, 'settings.update', 'appstore-offline-account', 'Apple Account session verified');
        return services.readiness();
      } catch (error) {
        if (error instanceof OfflineAppStoreAuthenticationError) {
          const message = error.code === 'two_factor_required'
            ? 'Apple requires a verification code. Approve the sign-in on the trusted iPad, then submit its six-digit code.'
            : 'Apple Account authentication failed. Check the account details and try again.';
          return reply.code(409).send({ ...createHttpErrorEnvelope(request.id, 409, message), code: error.code });
        }
        return reply.code(409).send(createHttpErrorEnvelope(request.id, 409, error instanceof Error ? error.message : 'Apple Account authentication failed'));
      }
    });

    server.put('/v1/dashboard/appstore-offline/credential', {
      schema: { hide: true, body: Type.Object({ credential: Type.String({ minLength: 16, maxLength: 128 }) }, { additionalProperties: false }) },
      preHandler: reauthenticatedAdministrator,
    }, (request, reply) => {
      try {
        services.saveCredential(request.body.credential);
        recordAudit(getFastifySession(request)!.sub, 'settings.update', 'appstore-offline-credential', 'Device-derived FairPlay credential updated');
        return services.readiness();
      } catch (error) {
        return reply.code(409).send(createHttpErrorEnvelope(request.id, 409, error instanceof Error ? error.message : 'Could not save FairPlay credential'));
      }
    });

    server.delete('/v1/dashboard/appstore-offline/account', {
      schema: { hide: true },
      preHandler: reauthenticatedAdministrator,
    }, (request, reply) => {
      if (!services.clear()) return reply.code(404).send(createHttpErrorEnvelope(request.id, 404, 'Apple Account is not configured'));
      recordAudit(getFastifySession(request)!.sub, 'settings.update', 'appstore-offline-account', 'Apple Account credentials removed');
      return services.readiness();
    });
  };
}

export const dashboardOfflineAppStoreRoutes = createDashboardOfflineAppStoreRoutes();

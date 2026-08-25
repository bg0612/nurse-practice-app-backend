import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import {
  buildProvidersConfigFromEnv,
  clearProvidersConfigCache,
  FOUNDRY_DEFAULTS,
  getProviderMode,
  getServiceFlags,
  loadProviderSecrets,
  loadProvidersConfig,
} from '../src/config/loadProviders.js';

const ENV_KEYS = [
  'PROVIDER_MODE',
  'LLM_ENABLED',
  'LLM_PROVIDER',
  'FOUNDRY_ENDPOINT',
  'FOUNDRY_DEPLOYMENT_NAME',
  'FOUNDRY_MODEL',
  'FOUNDRY_MODEL_VERSION',
  'FOUNDRY_AUTH_MODE',
  'FOUNDRY_API_KEY',
  'FOUNDRY_DEPLOYMENT_TYPE',
  'FOUNDRY_TIMEOUT_MS',
];

function clearTestEnv() {
  for (const key of ENV_KEYS) delete process.env[key];
}

function setValidFoundryEnv() {
  process.env.LLM_PROVIDER = 'microsoft-foundry';
  process.env.FOUNDRY_ENDPOINT = 'https://nursing-ai.services.ai.azure.com';
  process.env.FOUNDRY_DEPLOYMENT_NAME = 'deepseek-v4-flash-prod';
  process.env.FOUNDRY_MODEL = 'DeepSeek-V4-Flash';
  process.env.FOUNDRY_MODEL_VERSION = '2026-04-23';
  process.env.FOUNDRY_AUTH_MODE = 'api-key';
  process.env.FOUNDRY_API_KEY = 'test-secret-never-sent';
  process.env.FOUNDRY_DEPLOYMENT_TYPE = 'pay-as-you-go';
}

afterEach(() => {
  clearProvidersConfigCache();
  clearTestEnv();
});

describe('Microsoft Foundry provider config', () => {
  it('loads the approved Direct-from-Azure deployment metadata', () => {
    setValidFoundryEnv();
    process.env.FOUNDRY_TIMEOUT_MS = '35000';

    const config = loadProvidersConfig({ forceReload: true });

    assert.deepEqual(config.llm, {
      provider: 'microsoft-foundry',
      endpoint: 'https://nursing-ai.services.ai.azure.com',
      deploymentName: 'deepseek-v4-flash-prod',
      model: 'DeepSeek-V4-Flash',
      modelVersion: '2026-04-23',
      authMode: 'api-key',
      deploymentType: 'pay-as-you-go',
      timeoutMs: 35000,
    });
  });

  it('fails fast when required settings are absent', () => {
    clearTestEnv();
    assert.throws(
      () => buildProvidersConfigFromEnv(),
      /missing required env "FOUNDRY_ENDPOINT"/,
    );
  });

  it('rejects malformed endpoints and credential-bearing URLs', () => {
    setValidFoundryEnv();
    process.env.FOUNDRY_ENDPOINT = 'http://not-tls.example.test';
    assert.throws(() => buildProvidersConfigFromEnv(), /must be an HTTPS URL/);

    process.env.FOUNDRY_ENDPOINT = 'https://key@foundry.example.test';
    assert.throws(() => buildProvidersConfigFromEnv(), /without credentials/);
  });

  it('rejects Fireworks, wrong model/version, and non-pay-as-you-go settings', () => {
    setValidFoundryEnv();
    process.env.FOUNDRY_DEPLOYMENT_NAME = 'FW-deepseek-v4-flash';
    assert.throws(() => buildProvidersConfigFromEnv(), /Direct-from-Azure/);

    process.env.FOUNDRY_DEPLOYMENT_NAME = 'deepseek-v4-flash-prod';
    process.env.FOUNDRY_MODEL_VERSION = '2026-01-01';
    assert.throws(() => buildProvidersConfigFromEnv(), /FOUNDRY_MODEL_VERSION/);

    process.env.FOUNDRY_MODEL_VERSION = '2026-04-23';
    process.env.FOUNDRY_DEPLOYMENT_TYPE = 'provisioned';
    assert.throws(() => buildProvidersConfigFromEnv(), /FOUNDRY_DEPLOYMENT_TYPE/);
  });

  it('accepts only the two designed authentication modes', () => {
    setValidFoundryEnv();
    process.env.FOUNDRY_AUTH_MODE = 'managed-identity';
    assert.equal(buildProvidersConfigFromEnv().llm.authMode, 'managed-identity');

    process.env.FOUNDRY_AUTH_MODE = 'bearer-token';
    assert.throws(() => buildProvidersConfigFromEnv(), /api-key.*managed-identity/);
  });

  it('validates timeout bounds and defaults safely', () => {
    setValidFoundryEnv();
    assert.equal(buildProvidersConfigFromEnv().llm.timeoutMs, 20000);

    process.env.FOUNDRY_TIMEOUT_MS = '0';
    assert.throws(() => buildProvidersConfigFromEnv(), /between 1 and 300000/);

    process.env.FOUNDRY_TIMEOUT_MS = '2.5';
    assert.throws(() => buildProvidersConfigFromEnv(), /must be an integer/);
  });

  it('provides complete non-secret defaults only when mock defaults are requested', () => {
    clearTestEnv();
    const config = buildProvidersConfigFromEnv({ mockDefaults: true });

    assert.equal(config.llm.provider, FOUNDRY_DEFAULTS.provider);
    assert.equal(config.llm.model, FOUNDRY_DEFAULTS.model);
    assert.equal(config.llm.modelVersion, FOUNDRY_DEFAULTS.modelVersion);
    assert.equal(config.llm.deploymentType, FOUNDRY_DEFAULTS.deploymentType);
    assert.match(config.llm.endpoint, /^https:/);
  });

  it('caches validated config until explicitly reloaded', () => {
    setValidFoundryEnv();
    const first = loadProvidersConfig({ forceReload: true });
    process.env.FOUNDRY_DEPLOYMENT_NAME = 'different-deployment';

    assert.strictEqual(loadProvidersConfig(), first);
    assert.equal(
      loadProvidersConfig({ forceReload: true }).llm.deploymentName,
      'different-deployment',
    );
  });

  it('loads secrets separately from public configuration', () => {
    setValidFoundryEnv();
    const config = buildProvidersConfigFromEnv();
    const secrets = loadProviderSecrets();

    assert.deepEqual(secrets, { foundryApiKey: 'test-secret-never-sent' });
    assert.ok(!JSON.stringify(config).includes('test-secret-never-sent'));
  });
});

describe('provider flags', () => {
  it('defaults to mock mode and enabled LLM', () => {
    clearTestEnv();
    assert.equal(getProviderMode(), 'mock');
    assert.deepEqual(getServiceFlags(), { llmEnabled: true });
  });

  it('parses live mode and the LLM feature flag', () => {
    process.env.PROVIDER_MODE = 'live';
    process.env.LLM_ENABLED = 'false';
    assert.equal(getProviderMode(), 'live');
    assert.deepEqual(getServiceFlags(), { llmEnabled: false });
  });
});

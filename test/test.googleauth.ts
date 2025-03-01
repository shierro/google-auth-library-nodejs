// Copyright 2014 Google LLC
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//      http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

import * as assert from 'assert';
import {describe, it, beforeEach, afterEach} from 'mocha';
import * as child_process from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import {
  BASE_PATH,
  HEADERS,
  HOST_ADDRESS,
  SECONDARY_HOST_ADDRESS,
  resetIsAvailableCache,
} from 'gcp-metadata';
import * as nock from 'nock';
import * as os from 'os';
import * as path from 'path';
import * as sinon from 'sinon';

import {GoogleAuth, JWT, UserRefreshClient, IdTokenClient} from '../src';
import {CredentialBody} from '../src/auth/credentials';
import * as envDetect from '../src/auth/envDetect';
import {Compute} from '../src/auth/computeclient';
import * as messages from '../src/messages';

nock.disableNetConnect();

describe('googleauth', () => {
  const isWindows = process.platform === 'win32';

  const tokenPath = `${BASE_PATH}/instance/service-accounts/default/token`;
  const host = HOST_ADDRESS;
  const instancePath = `${BASE_PATH}/instance`;
  const svcAccountPath = `${instancePath}/service-accounts/?recursive=true`;
  const API_KEY = 'test-123';
  const STUB_PROJECT = 'my-awesome-project';
  const ENDPOINT = '/events:report';
  const RESPONSE_BODY = 'RESPONSE_BODY';
  const BASE_URL = [
    'https://clouderrorreporting.googleapis.com/v1beta1/projects',
    STUB_PROJECT,
  ].join('/');

  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const privateJSON = require('../../test/fixtures/private.json');
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const private2JSON = require('../../test/fixtures/private2.json');
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const refreshJSON = require('../../test/fixtures/refresh.json');
  const privateKey = fs.readFileSync('./test/fixtures/private.pem', 'utf-8');
  const wellKnownPathWindows = path.join(
    'C:',
    'fake',
    'home',
    'gcloud',
    'application_default_credentials.json'
  );
  const wellKnownPathLinux = path.join(
    '/',
    'fake',
    'user',
    '.config',
    'gcloud',
    'application_default_credentials.json'
  );

  describe('googleauth', () => {
    let auth: GoogleAuth;
    const sandbox = sinon.createSandbox();
    let osStub: sinon.SinonStub<[], NodeJS.Platform>;
    let exposeWindowsWellKnownFile: boolean;
    let exposeLinuxWellKnownFile: boolean;
    let createLinuxWellKnownStream: Function;
    let createWindowsWellKnownStream: Function;
    beforeEach(() => {
      resetIsAvailableCache();
      auth = new GoogleAuth();
      exposeWindowsWellKnownFile = false;
      exposeLinuxWellKnownFile = false;
      createLinuxWellKnownStream = () => {
        throw new Error();
      };
      createWindowsWellKnownStream = () => {
        throw new Error();
      };
      const envVars = Object.assign({}, process.env, {
        GCLOUD_PROJECT: undefined,
        GOOGLE_APPLICATION_CREDENTIALS: undefined,
        google_application_credentials: undefined,
        HOME: path.join('/', 'fake', 'user'),
      });
      sandbox.stub(process, 'env').value(envVars);
      osStub = sandbox.stub(os, 'platform').returns('linux');
      sandbox
        .stub(fs, 'existsSync')
        .callThrough()
        .withArgs(wellKnownPathLinux)
        .callsFake(() => exposeLinuxWellKnownFile)
        .withArgs(wellKnownPathWindows)
        .callsFake(() => exposeWindowsWellKnownFile);

      sandbox
        .stub(fs, 'createReadStream')
        .callThrough()
        .withArgs(wellKnownPathLinux)
        .callsFake(() => createLinuxWellKnownStream())
        .withArgs(wellKnownPathWindows)
        .callsFake(() => createWindowsWellKnownStream());

      sandbox
        .stub(fs, 'realpathSync')
        .callThrough()
        .withArgs(wellKnownPathLinux)
        .returnsArg(0)
        .withArgs(wellKnownPathWindows)
        .returnsArg(0);

      sandbox
        .stub(child_process, 'exec')
        .callThrough()
        .withArgs('gcloud config config-helper --format json', sinon.match.func)
        .callsArgWith(1, null, '', null);

      const fakeStat = {isFile: () => true} as fs.Stats;
      sandbox
        .stub(fs, 'lstatSync')
        .callThrough()
        .withArgs(wellKnownPathLinux)
        .returns(fakeStat)
        .withArgs(wellKnownPathWindows)
        .returns(fakeStat);
    });

    afterEach(() => {
      nock.cleanAll();
      sandbox.restore();
    });

    function mockWindows() {
      osStub.returns('win32');
      process.env.HOME = '';
      process.env.APPDATA = path.join('C:', 'fake', 'home');
    }

    function mockWindowsWellKnownFile() {
      exposeWindowsWellKnownFile = true;
      createWindowsWellKnownStream = () =>
        fs.createReadStream('./test/fixtures/private2.json');
    }

    function mockLinuxWellKnownFile() {
      exposeLinuxWellKnownFile = true;
      createLinuxWellKnownStream = () =>
        fs.createReadStream('./test/fixtures/private2.json');
    }

    function nockIsGCE() {
      const primary = nock(host).get(instancePath).reply(200, {}, HEADERS);
      const secondary = nock(SECONDARY_HOST_ADDRESS)
        .get(instancePath)
        .reply(200, {}, HEADERS);

      return {
        done: () => {
          try {
            primary.done();
            secondary.done();
          } catch (_err) {
            // secondary can sometimes complete prior to primary.
          }
        },
      };
    }

    function nockNotGCE() {
      const primary = nock(host)
        .get(instancePath)
        .replyWithError({code: 'ENOTFOUND'});
      const secondary = nock(SECONDARY_HOST_ADDRESS)
        .get(instancePath)
        .replyWithError({code: 'ENOTFOUND'});
      return {
        done: () => {
          try {
            primary.done();
            secondary.done();
          } catch (_err) {
            // secondary can sometimes complete prior to primary.
          }
        },
      };
    }

    function nock500GCE() {
      const primary = nock(host).get(instancePath).reply(500, {}, HEADERS);
      const secondary = nock(SECONDARY_HOST_ADDRESS)
        .get(instancePath)
        .reply(500, {}, HEADERS);

      return {
        done: () => {
          try {
            primary.done();
            secondary.done();
          } catch (err) {
            // secondary can sometimes complete prior to primary.
          }
        },
      };
    }

    function nock404GCE() {
      const primary = nock(host).get(instancePath).reply(404);
      const secondary = nock(SECONDARY_HOST_ADDRESS)
        .get(instancePath)
        .reply(404);
      return {
        done: () => {
          try {
            primary.done();
            secondary.done();
          } catch (err) {
            // secondary can sometimes complete prior to primary.
          }
        },
      };
    }

    function createGetProjectIdNock(projectId = 'not-real') {
      return nock(host)
        .get(`${BASE_PATH}/project/project-id`)
        .reply(200, projectId, HEADERS);
    }

    // Creates a standard JSON auth object for testing.
    function createJwtJSON() {
      return {
        private_key_id: 'key123',
        private_key: 'privatekey',
        client_email: 'hello@youarecool.com',
        client_id: 'client123',
        type: 'service_account',
      };
    }

    // Pretend that we're GCE, and mock an access token.
    function mockGCE() {
      const scope1 = nockIsGCE();
      const auth = new GoogleAuth();
      // tslint:disable-next-line no-any
      sinon.stub(auth as any, 'getDefaultServiceProjectId').resolves();
      const scope2 = nock(HOST_ADDRESS)
        .get(tokenPath)
        .reply(200, {access_token: 'abc123', expires_in: 10000}, HEADERS);
      return {auth, scopes: [scope1, scope2]};
    }

    // Intercepts the specified environment variable, returning the specified
    // value.
    function mockEnvVar(name: string, value = '') {
      const envVars = Object.assign({}, process.env, {[name]: value});
      return sandbox.stub(process, 'env').value(envVars);
    }

    it('fromJSON should support the instantiated named export', () => {
      const result = auth.fromJSON(createJwtJSON());
      assert(result);
    });

    it('fromJson should error on null json', () => {
      const auth = new GoogleAuth();
      assert.throws(() => {
        // Test verifies invalid parameter tests, which requires cast to any.
        // tslint:disable-next-line no-any
        (auth as any).fromJSON(null);
      });
    });

    it('fromJson should not overwrite previous client configuration', async () => {
      const auth = new GoogleAuth({
        keyFilename: './test/fixtures/private.json',
      });
      auth.fromJSON({
        client_email: 'batman@example.com',
        private_key: 'abc123',
      });
      const client = (await auth.getClient()) as JWT;
      assert.strictEqual(client.email, 'hello@youarecool.com');
    });

    it('fromAPIKey should error given an invalid api key', () => {
      assert.throws(() => {
        // Test verifies invalid parameter tests, which requires cast to any.
        // tslint:disable-next-line no-any
        (auth as any).fromAPIKey(null);
      });
    });

    it('should make a request with the api key', async () => {
      const scope = nock(BASE_URL)
        .post(ENDPOINT)
        .reply(function (uri) {
          assert.strictEqual(this.req.headers['x-goog-api-key'][0], API_KEY);
          return [200, RESPONSE_BODY];
        });
      const client = auth.fromAPIKey(API_KEY);
      const res = await client.request({
        url: BASE_URL + ENDPOINT,
        method: 'POST',
        data: {test: true},
      });
      assert.strictEqual(RESPONSE_BODY, res.data);
      scope.done();
    });

    it('should put the api key in the headers', async () => {
      const client = auth.fromAPIKey(API_KEY);
      const headers = await client.getRequestHeaders();
      assert.strictEqual(headers['X-Goog-Api-Key'], API_KEY);
    });

    it('should make a request while preserving original parameters', async () => {
      const OTHER_QS_PARAM = {test: 'abc'};
      const scope = nock(BASE_URL)
        .post(ENDPOINT)
        .query({test: OTHER_QS_PARAM.test})
        .reply(function (uri) {
          assert.strictEqual(this.req.headers['x-goog-api-key'][0], API_KEY);
          assert(uri.indexOf('test=' + OTHER_QS_PARAM.test) > -1);
          return [200, RESPONSE_BODY];
        });
      const client = auth.fromAPIKey(API_KEY);
      const res = await client.request({
        url: BASE_URL + ENDPOINT,
        method: 'POST',
        data: {test: true},
        params: OTHER_QS_PARAM,
      });
      assert.strictEqual(RESPONSE_BODY, res.data);
      scope.done();
    });

    it('should make client with eagerRetryThresholdMillis set', () => {
      const client = auth.fromAPIKey(API_KEY, {
        eagerRefreshThresholdMillis: 100,
      });
      assert.strictEqual(100, client.eagerRefreshThresholdMillis);
    });

    it('fromJSON should error on empty json', () => {
      const auth = new GoogleAuth();
      assert.throws(() => {
        auth.fromJSON({});
      });
    });

    it('fromJSON should error on missing client_email', () => {
      const json = createJwtJSON();
      delete json.client_email;
      assert.throws(() => {
        auth.fromJSON(json);
      });
    });

    it('fromJSON should error on missing private_key', () => {
      const json = createJwtJSON();
      delete json.private_key;
      assert.throws(() => {
        auth.fromJSON(json);
      });
    });

    it('fromJSON should create JWT with client_email', () => {
      const json = createJwtJSON();
      const result = auth.fromJSON(json);
      assert.strictEqual(json.client_email, (result as JWT).email);
    });

    it('fromJSON should create JWT with private_key', () => {
      const json = createJwtJSON();
      const result = auth.fromJSON(json);
      assert.strictEqual(json.private_key, (result as JWT).key);
    });

    it('fromJSON should create JWT with null scopes', () => {
      const json = createJwtJSON();
      const result = auth.fromJSON(json);
      assert.strictEqual(undefined, (result as JWT).scopes);
    });

    it('fromJSON should create JWT with null subject', () => {
      const json = createJwtJSON();
      const result = auth.fromJSON(json);
      assert.strictEqual(undefined, (result as JWT).subject);
    });

    it('fromJSON should create JWT with null keyFile', () => {
      const json = createJwtJSON();
      const result = auth.fromJSON(json);
      assert.strictEqual(undefined, (result as JWT).keyFile);
    });

    it('fromJSON should create JWT which eagerRefreshThresholdMillisset when this is set for GoogleAuth', () => {
      const json = createJwtJSON();
      const result = auth.fromJSON(json, {eagerRefreshThresholdMillis: 5000});
      assert.strictEqual(5000, (result as JWT).eagerRefreshThresholdMillis);
    });

    it('fromJSON should create JWT with 5min as value for eagerRefreshThresholdMillis', () => {
      const json = createJwtJSON();
      const result = auth.fromJSON(json);
      assert.strictEqual(300000, (result as JWT).eagerRefreshThresholdMillis);
    });

    it('fromStream should error on null stream', done => {
      // Test verifies invalid parameter tests, which requires cast to any.
      // tslint:disable-next-line no-any
      (auth as any).fromStream(null, (err: Error) => {
        assert.strictEqual(true, err instanceof Error);
        done();
      });
    });

    it('fromStream should read the stream and create a jwt', async () => {
      const stream = fs.createReadStream('./test/fixtures/private.json');
      const res = await auth.fromStream(stream);
      const jwt = res as JWT;
      // Ensure that the correct bits were pulled from the stream.
      assert.strictEqual(privateJSON.private_key, jwt.key);
      assert.strictEqual(privateJSON.client_email, jwt.email);
      assert.strictEqual(undefined, jwt.keyFile);
      assert.strictEqual(undefined, jwt.subject);
      assert.strictEqual(undefined, jwt.scope);
    });

    it('fromStream should read the stream and create a jwt with eager refresh', async () => {
      const stream = fs.createReadStream('./test/fixtures/private.json');
      const auth = new GoogleAuth();
      const result = await auth.fromStream(stream, {
        eagerRefreshThresholdMillis: 1000 * 60 * 60,
      });
      const jwt = result as JWT;
      // Ensure that the correct bits were pulled from the stream.
      assert.strictEqual(privateJSON.private_key, jwt.key);
      assert.strictEqual(privateJSON.client_email, jwt.email);
      assert.strictEqual(undefined, jwt.keyFile);
      assert.strictEqual(undefined, jwt.subject);
      assert.strictEqual(undefined, jwt.scope);
      assert.strictEqual(1000 * 60 * 60, jwt.eagerRefreshThresholdMillis);
    });

    it('should read another stream and create a UserRefreshClient', async () => {
      const stream = fs.createReadStream('./test/fixtures/refresh.json');
      const auth = new GoogleAuth();
      const res = await auth.fromStream(stream);
      // Ensure that the correct bits were pulled from the stream.
      const rc = res as UserRefreshClient;
      assert.strictEqual(refreshJSON.client_id, rc._clientId);
      assert.strictEqual(refreshJSON.client_secret, rc._clientSecret);
      assert.strictEqual(refreshJSON.refresh_token, rc._refreshToken);
    });

    it('should read another stream and create a UserRefreshClient with eager refresh', async () => {
      const stream = fs.createReadStream('./test/fixtures/refresh.json');
      const auth = new GoogleAuth();
      const result = await auth.fromStream(stream, {
        eagerRefreshThresholdMillis: 100,
      });
      // Ensure that the correct bits were pulled from the stream.
      const rc = result as UserRefreshClient;
      assert.strictEqual(refreshJSON.client_id, rc._clientId);
      assert.strictEqual(refreshJSON.client_secret, rc._clientSecret);
      assert.strictEqual(refreshJSON.refresh_token, rc._refreshToken);
      assert.strictEqual(100, rc.eagerRefreshThresholdMillis);
    });

    it('getApplicationCredentialsFromFilePath should not error on valid symlink', async () => {
      if (isWindows) {
        // git does not create symlinks on Windows
        return;
      }
      await auth._getApplicationCredentialsFromFilePath(
        './test/fixtures/goodlink'
      );
    });

    it('getApplicationCredentialsFromFilePath should error on invalid symlink', async () => {
      await assert.rejects(
        auth._getApplicationCredentialsFromFilePath('./test/fixtures/badlink')
      );
    });

    it('getApplicationCredentialsFromFilePath should error on valid link to invalid data', async () => {
      if (isWindows) {
        // git does not create symlinks on Windows
        return;
      }
      await assert.rejects(
        auth._getApplicationCredentialsFromFilePath('./test/fixtures/emptylink')
      );
    });

    it('getApplicationCredentialsFromFilePath should error on null file path', async () => {
      try {
        // Test verifies invalid parameter tests, which requires cast to any.
        // tslint:disable-next-line no-any
        await (auth as any)._getApplicationCredentialsFromFilePath(null);
      } catch (e) {
        return;
      }
      assert.fail('failed to throw');
    });

    it('getApplicationCredentialsFromFilePath should error on empty file path', async () => {
      try {
        await auth._getApplicationCredentialsFromFilePath('');
      } catch (e) {
        return;
      }
      assert.fail('failed to throw');
    });

    it('getApplicationCredentialsFromFilePath should error on non-string file path', async () => {
      try {
        // Test verifies invalid parameter tests, which requires cast to any.
        // tslint:disable-next-line no-any
        await auth._getApplicationCredentialsFromFilePath(2 as any);
      } catch (e) {
        return;
      }
      assert.fail('failed to throw');
    });

    it('getApplicationCredentialsFromFilePath should error on invalid file path', async () => {
      try {
        await auth._getApplicationCredentialsFromFilePath(
          './nonexistantfile.json'
        );
      } catch (e) {
        return;
      }
      assert.fail('failed to throw');
    });

    it('getApplicationCredentialsFromFilePath should error on directory', async () => {
      // Make sure that the following path actually does point to a directory.
      const directory = './test/fixtures';
      await assert.rejects(
        auth._getApplicationCredentialsFromFilePath(directory)
      );
    });

    it('getApplicationCredentialsFromFilePath should handle errors thrown from createReadStream', async () => {
      await assert.rejects(
        auth._getApplicationCredentialsFromFilePath('./does/not/exist.json'),
        /ENOENT: no such file or directory/
      );
    });

    it('getApplicationCredentialsFromFilePath should handle errors thrown from fromStream', async () => {
      sandbox.stub(auth, 'fromStream').throws('🤮');
      await assert.rejects(
        auth._getApplicationCredentialsFromFilePath(
          './test/fixtures/private.json'
        ),
        /🤮/
      );
    });

    it('getApplicationCredentialsFromFilePath should handle errors passed from fromStream', async () => {
      // Set up a mock to return an error from the fromStream method.
      sandbox.stub(auth, 'fromStream').throws('🤮');
      await assert.rejects(
        auth._getApplicationCredentialsFromFilePath(
          './test/fixtures/private.json'
        ),
        /🤮/
      );
    });

    it('getApplicationCredentialsFromFilePath should correctly read the file and create a valid JWT', async () => {
      const result = await auth._getApplicationCredentialsFromFilePath(
        './test/fixtures/private.json'
      );
      assert(result);
      const jwt = result as JWT;
      assert.strictEqual(privateJSON.private_key, jwt.key);
      assert.strictEqual(privateJSON.client_email, jwt.email);
      assert.strictEqual(undefined, jwt.keyFile);
      assert.strictEqual(undefined, jwt.subject);
      assert.strictEqual(undefined, jwt.scope);
    });

    it('getApplicationCredentialsFromFilePath should correctly read the file and create a valid JWT with eager refresh', async () => {
      const result = await auth._getApplicationCredentialsFromFilePath(
        './test/fixtures/private.json',
        {eagerRefreshThresholdMillis: 7000}
      );
      assert(result);
      const jwt = result as JWT;
      assert.strictEqual(privateJSON.private_key, jwt.key);
      assert.strictEqual(privateJSON.client_email, jwt.email);
      assert.strictEqual(undefined, jwt.keyFile);
      assert.strictEqual(undefined, jwt.subject);
      assert.strictEqual(undefined, jwt.scope);
      assert.strictEqual(7000, jwt.eagerRefreshThresholdMillis);
    });

    it('tryGetApplicationCredentialsFromEnvironmentVariable should return null when env const is not set', async () => {
      // Set up a mock to return a null path string.
      mockEnvVar('GOOGLE_APPLICATION_CREDENTIALS');
      const client = await auth._tryGetApplicationCredentialsFromEnvironmentVariable();
      assert.strictEqual(client, null);
    });

    it('tryGetApplicationCredentialsFromEnvironmentVariable should return null when env const is empty string', async () => {
      // Set up a mock to return an empty path string.
      const stub = mockEnvVar('GOOGLE_APPLICATION_CREDENTIALS');
      const client = await auth._tryGetApplicationCredentialsFromEnvironmentVariable();
      assert.strictEqual(client, null);
    });

    it('tryGetApplicationCredentialsFromEnvironmentVariable should handle invalid environment variable', async () => {
      // Set up a mock to return a path to an invalid file.
      mockEnvVar('GOOGLE_APPLICATION_CREDENTIALS', './nonexistantfile.json');
      try {
        await auth._tryGetApplicationCredentialsFromEnvironmentVariable();
      } catch (e) {
        return;
      }
      assert.fail('failed to throw');
    });

    it('tryGetApplicationCredentialsFromEnvironmentVariable should handle valid environment variable', async () => {
      // Set up a mock to return path to a valid credentials file.
      mockEnvVar(
        'GOOGLE_APPLICATION_CREDENTIALS',
        './test/fixtures/private.json'
      );
      const result = await auth._tryGetApplicationCredentialsFromEnvironmentVariable();
      const jwt = result as JWT;
      assert.strictEqual(privateJSON.private_key, jwt.key);
      assert.strictEqual(privateJSON.client_email, jwt.email);
      assert.strictEqual(undefined, jwt.keyFile);
      assert.strictEqual(undefined, jwt.subject);
      assert.strictEqual(undefined, jwt.scope);
    });

    it('tryGetApplicationCredentialsFromEnvironmentVariable should handle valid environment variable when there is eager refresh set', async () => {
      // Set up a mock to return path to a valid credentials file.
      mockEnvVar(
        'GOOGLE_APPLICATION_CREDENTIALS',
        './test/fixtures/private.json'
      );
      const result = await auth._tryGetApplicationCredentialsFromEnvironmentVariable(
        {eagerRefreshThresholdMillis: 60 * 60 * 1000}
      );
      const jwt = result as JWT;
      assert.strictEqual(privateJSON.private_key, jwt.key);
      assert.strictEqual(privateJSON.client_email, jwt.email);
      assert.strictEqual(undefined, jwt.keyFile);
      assert.strictEqual(undefined, jwt.subject);
      assert.strictEqual(undefined, jwt.scope);
      assert.strictEqual(60 * 60 * 1000, jwt.eagerRefreshThresholdMillis);
    });

    it('_tryGetApplicationCredentialsFromWellKnownFile should build the correct directory for Windows', async () => {
      mockWindows();
      mockWindowsWellKnownFile();
      const result = (await auth._tryGetApplicationCredentialsFromWellKnownFile()) as JWT;
      assert.ok(result);
      assert.strictEqual(result.email, private2JSON.client_email);
    });

    it('_tryGetApplicationCredentialsFromWellKnownFile should build the correct directory for non-Windows', async () => {
      mockLinuxWellKnownFile();
      const client = (await auth._tryGetApplicationCredentialsFromWellKnownFile()) as JWT;
      assert.strictEqual(client.email, private2JSON.client_email);
    });

    it('_tryGetApplicationCredentialsFromWellKnownFile should fail on Windows when APPDATA is not defined', async () => {
      mockWindows();
      mockEnvVar('APPDATA');
      mockWindowsWellKnownFile();
      const result = await auth._tryGetApplicationCredentialsFromWellKnownFile();
      assert.strictEqual(null, result);
    });

    it('_tryGetApplicationCredentialsFromWellKnownFile should fail on non-Windows when HOME is not defined', async () => {
      mockEnvVar('HOME');
      mockLinuxWellKnownFile();
      const result = await auth._tryGetApplicationCredentialsFromWellKnownFile();
      assert.strictEqual(null, result);
    });

    it('_tryGetApplicationCredentialsFromWellKnownFile should fail on Windows when file does not exist', async () => {
      mockWindows();
      const result = await auth._tryGetApplicationCredentialsFromWellKnownFile();
      assert.strictEqual(null, result);
    });

    it('_tryGetApplicationCredentialsFromWellKnownFile should fail on non-Windows when file does not exist', async () => {
      const result = await auth._tryGetApplicationCredentialsFromWellKnownFile();
      assert.strictEqual(null, result);
    });

    it('_tryGetApplicationCredentialsFromWellKnownFile should pass along a failure on Windows', async () => {
      mockWindows();
      mockWindowsWellKnownFile();
      sandbox
        .stub(auth, '_getApplicationCredentialsFromFilePath')
        .rejects('🤮');
      await assert.rejects(
        auth._tryGetApplicationCredentialsFromWellKnownFile(),
        /🤮/
      );
    });

    it('_tryGetApplicationCredentialsFromWellKnownFile should pass along a failure on non-Windows', async () => {
      mockLinuxWellKnownFile();
      sandbox
        .stub(auth, '_getApplicationCredentialsFromFilePath')
        .rejects('🤮');
      await assert.rejects(
        auth._tryGetApplicationCredentialsFromWellKnownFile(),
        /🤮/
      );
    });

    it('getProjectId should return a new projectId the first time and a cached projectId the second time', async () => {
      mockEnvVar('GCLOUD_PROJECT', STUB_PROJECT);

      // Ask for credentials, the first time.
      const projectIdPromise = auth.getProjectId();
      const projectId = await projectIdPromise;
      assert.strictEqual(projectId, STUB_PROJECT);

      // Null out all the private functions that make this method work
      // tslint:disable-next-line no-any
      const anyd = auth as any;
      anyd.getProductionProjectId = null;
      anyd.getFileProjectId = null;
      anyd.getDefaultServiceProjectId = null;
      anyd.getGCEProjectId = null;

      // Ask for projectId again, from the same auth instance. If it isn't
      // cached, this will crash.
      const projectId2 = await auth.getProjectId();

      // Make sure we get the original cached projectId back
      assert.strictEqual(STUB_PROJECT, projectId2);

      // Now create a second GoogleAuth instance, and ask for projectId.
      // We should get a new projectId instance this time.
      const auth2 = new GoogleAuth();

      const getProjectIdPromise = auth2.getProjectId();
      assert.notStrictEqual(getProjectIdPromise, projectIdPromise);
    });

    it('getProjectId should use GCLOUD_PROJECT environment variable when it is set', async () => {
      mockEnvVar('GCLOUD_PROJECT', STUB_PROJECT);
      const projectId = await auth.getProjectId();
      assert.strictEqual(projectId, STUB_PROJECT);
    });

    it('getProjectId should use `gcloud_project` environment variable when it is set', async () => {
      process.env.gcloud_project = STUB_PROJECT;
      const projectId = await auth.getProjectId();
      assert.strictEqual(projectId, STUB_PROJECT);
    });

    it('getProjectId should use GOOGLE_CLOUD_PROJECT environment variable when it is set', async () => {
      process.env.GOOGLE_CLOUD_PROJECT = STUB_PROJECT;
      const projectId = await auth.getProjectId();
      assert.strictEqual(projectId, STUB_PROJECT);
    });

    it('getProjectId should use `google_cloud_project` environment variable when it is set', async () => {
      process.env['google_cloud_project'] = STUB_PROJECT;
      const projectId = await auth.getProjectId();
      assert.strictEqual(projectId, STUB_PROJECT);
    });

    it('getProjectId should use `keyFilename` when it is available', async () => {
      const auth = new GoogleAuth({
        keyFilename: './test/fixtures/private2.json',
      });
      const projectId = await auth.getProjectId();
      assert.strictEqual(projectId, STUB_PROJECT);
    });

    it('getProjectId should use GOOGLE_APPLICATION_CREDENTIALS file when it is available', async () => {
      process.env.GOOGLE_APPLICATION_CREDENTIALS =
        './test/fixtures/private2.json';
      const projectId = await auth.getProjectId();
      assert.strictEqual(projectId, STUB_PROJECT);
    });

    it('getProjectId should use `google_application_credentials` file when it is available', async () => {
      process.env['google_application_credentials'] =
        './test/fixtures/private2.json';
      const projectId = await auth.getProjectId();
      assert.strictEqual(projectId, STUB_PROJECT);
    });

    it('getProjectId should prefer configured projectId', async () => {
      mockEnvVar('GCLOUD_PROJECT', STUB_PROJECT);
      mockEnvVar('GOOGLE_CLOUD_PROJECT', STUB_PROJECT);
      mockEnvVar(
        'GOOGLE_APPLICATION_CREDENTIALS',
        './test/fixtures/private2.json'
      );
      const PROJECT_ID = 'configured-project-id-should-be-preferred';
      const auth = new GoogleAuth({projectId: PROJECT_ID});
      const projectId = await auth.getProjectId();
      assert.strictEqual(projectId, PROJECT_ID);
    });

    it('getProjectId should use Cloud SDK when it is available and env vars are not set', async () => {
      // Set up the creds.
      // * Environment variable is not set.
      // * Well-known file is set up to point to private2.json
      // * Running on GCE is set to true.
      const stdout = JSON.stringify({
        configuration: {properties: {core: {project: STUB_PROJECT}}},
      });

      ((child_process.exec as unknown) as sinon.SinonStub).restore();
      const stub = sandbox
        .stub(child_process, 'exec')
        .callsArgWith(1, null, stdout, null);
      const projectId = await auth.getProjectId();
      assert(stub.calledOnce);
      assert.strictEqual(projectId, STUB_PROJECT);
    });

    it('getProjectId should use GCE when well-known file and env const are not set', async () => {
      const scope = createGetProjectIdNock(STUB_PROJECT);
      const projectId = await auth.getProjectId();
      const stub = (child_process.exec as unknown) as sinon.SinonStub;
      stub.restore();
      assert(stub.calledOnce);
      assert.strictEqual(projectId, STUB_PROJECT);
      scope.done();
    });

    it('getApplicationDefault should return a new credential the first time and a cached credential the second time', async () => {
      // Create a function which will set up a GoogleAuth instance to match
      // on an environment variable json file, but not on anything else.
      mockEnvVar(
        'GOOGLE_APPLICATION_CREDENTIALS',
        './test/fixtures/private2.json'
      );

      // Ask for credentials, the first time.
      const result = await auth.getApplicationDefault();
      assert.notStrictEqual(null, result);

      // Capture the returned credential.
      const cachedCredential = result.credential;

      // Make sure our special test bit is not set yet, indicating that
      // this is a new credentials instance.
      // Test verifies invalid parameter tests, which requires cast to any.
      // tslint:disable-next-line no-any
      assert.strictEqual(undefined, (cachedCredential as any).specialTestBit);

      // Now set the special test bit.
      // Test verifies invalid parameter tests, which requires cast to any.
      // tslint:disable-next-line no-any
      (cachedCredential as any).specialTestBit = 'monkey';

      // Ask for credentials again, from the same auth instance. We expect
      // a cached instance this time.
      const result2 = (await auth.getApplicationDefault()).credential;
      assert.notStrictEqual(null, result2);

      // Make sure the special test bit is set on the credentials we got
      // back, indicating that we got cached credentials. Also make sure
      // the object instance is the same.
      // Test verifies invalid parameter tests, which requires cast to
      // any.
      // tslint:disable-next-line no-any
      assert.strictEqual('monkey', (result2 as any).specialTestBit);
      assert.strictEqual(cachedCredential, result2);

      // Now create a second GoogleAuth instance, and ask for
      // credentials. We should get a new credentials instance this time.
      const auth2 = new GoogleAuth();
      const result3 = (await auth2.getApplicationDefault()).credential;
      assert.notStrictEqual(null, result3);

      // Make sure we get a new (non-cached) credential instance back.
      // Test verifies invalid parameter tests, which requires cast to
      // any.
      // tslint:disable-next-line no-any
      assert.strictEqual(undefined, (result3 as any).specialTestBit);
      assert.notStrictEqual(cachedCredential, result3);
    });

    it('getApplicationDefault should cache the credential when using GCE', async () => {
      const scopes = [nockIsGCE(), createGetProjectIdNock()];

      // Ask for credentials, the first time.
      const result = await auth.getApplicationDefault();
      scopes.forEach(x => x.done());
      assert.notStrictEqual(null, result);

      // Capture the returned credential.
      const cachedCredential = result.credential;
      // Ask for credentials again, from the same auth instance. We expect
      // a cached instance this time.
      const result2 = (await auth.getApplicationDefault()).credential;
      assert.notStrictEqual(null, result2);

      // Make sure it's the same object
      assert.strictEqual(cachedCredential, result2);
    });

    it('getApplicationDefault should use environment variable when it is set', async () => {
      // Set up the creds.
      // * Environment variable is set up to point to private.json
      // * Well-known file is set up to point to private2.json
      // * Running on GCE is set to true.
      mockEnvVar(
        'GOOGLE_APPLICATION_CREDENTIALS',
        './test/fixtures/private2.json'
      );
      mockWindows();
      mockWindowsWellKnownFile();
      nockIsGCE();

      const res = await auth.getApplicationDefault();
      const client = res.credential as JWT;
      assert.strictEqual(private2JSON.private_key, client.key);
      assert.strictEqual(private2JSON.client_email, client.email);
      assert.strictEqual(undefined, client.keyFile);
      assert.strictEqual(undefined, client.subject);
      assert.strictEqual(undefined, client.scope);
    });

    it('should use well-known file when it is available and env const is not set', async () => {
      // Set up the creds.
      // * Environment variable is not set.
      // * Well-known file is set up to point to private2.json
      mockLinuxWellKnownFile();

      const res = await auth.getApplicationDefault();
      const client = res.credential as JWT;
      assert.strictEqual(private2JSON.private_key, client.key);
      assert.strictEqual(private2JSON.client_email, client.email);
      assert.strictEqual(undefined, client.keyFile);
      assert.strictEqual(undefined, client.subject);
      assert.strictEqual(undefined, client.scope);
    });

    it('getApplicationDefault should use GCE when well-known file and env const are not set', async () => {
      // Set up the creds.
      // * Environment variable is not set.
      // * Well-known file is not set.
      // * Running on GCE is set to true.
      const scopes = [nockIsGCE(), createGetProjectIdNock()];
      const res = await auth.getApplicationDefault();
      scopes.forEach(x => x.done());
      // This indicates that we got a ComputeClient instance back, rather than
      // a JWTClient.
      assert.strictEqual(
        'compute-placeholder',
        res.credential.credentials.refresh_token
      );
    });

    it('getApplicationDefault should report GCE error when checking for GCE fails', async () => {
      // Set up the creds.
      // * Environment variable is not set.
      // * Well-known file is not set.
      // * Running on GCE is set to true.
      mockWindows();
      sandbox.stub(auth, '_checkIsGCE').rejects('🤮');
      await assert.rejects(
        auth.getApplicationDefault(),
        /Unexpected error determining execution environment/
      );
    });

    it('getApplicationDefault should also get project ID', async () => {
      // Set up the creds.
      // * Environment variable is set up to point to private.json
      // * Well-known file is set up to point to private2.json
      // * Running on GCE is set to true.
      mockEnvVar(
        'GOOGLE_APPLICATION_CREDENTIALS',
        './test/fixtures/private2.json'
      );
      mockEnvVar('GCLOUD_PROJECT', STUB_PROJECT);
      mockWindows();
      mockGCE();
      mockWindowsWellKnownFile();

      const res = await auth.getApplicationDefault();
      const client = res.credential as JWT;
      assert.strictEqual(private2JSON.private_key, client.key);
      assert.strictEqual(private2JSON.client_email, client.email);
      assert.strictEqual(res.projectId, STUB_PROJECT);
      assert.strictEqual(undefined, client.keyFile);
      assert.strictEqual(undefined, client.subject);
      assert.strictEqual(undefined, client.scope);
    });

    it('_checkIsGCE should set the _isGCE flag when running on GCE', async () => {
      assert.notStrictEqual(true, auth.isGCE);
      const scope = nockIsGCE();
      await auth._checkIsGCE();
      assert.strictEqual(true, auth.isGCE);
      scope.done();
    });

    it('_checkIsGCE should not set the _isGCE flag when not running on GCE', async () => {
      const scope = nockNotGCE();
      assert.notStrictEqual(true, auth.isGCE);
      await auth._checkIsGCE();
      assert.strictEqual(false, auth.isGCE);
      scope.done();
    });

    it('_checkIsGCE should retry the check for isGCE on transient http errors', async () => {
      assert.notStrictEqual(true, auth.isGCE);
      // the first request will fail, the second one will succeed
      const scopes = [nock500GCE(), nockIsGCE()];
      await auth._checkIsGCE();
      assert.strictEqual(true, auth.isGCE);
      scopes.forEach(s => s.done());
    });

    it('_checkIsGCE should throw on unexpected errors', async () => {
      assert.notStrictEqual(true, auth.isGCE);
      const scope = nock500GCE();
      await assert.rejects(auth._checkIsGCE());
      assert.strictEqual(undefined, auth.isGCE);
      scope.done();
    });

    it('_checkIsGCE should not retry the check for isGCE if it fails with an ENOTFOUND', async () => {
      assert.notStrictEqual(true, auth.isGCE);
      const scope = nockNotGCE();
      await auth._checkIsGCE();
      assert.strictEqual(false, auth.isGCE);
      scope.done();
    });

    it('_checkIsGCE does not execute the second time when running on GCE', async () => {
      // This test relies on the nock mock only getting called once.
      assert.notStrictEqual(true, auth.isGCE);
      const scope = nockIsGCE();
      await auth._checkIsGCE();
      assert.strictEqual(true, auth.isGCE);
      await auth._checkIsGCE();
      assert.strictEqual(true, auth.isGCE);
      scope.done();
    });

    it('_checkIsGCE does not execute the second time when not running on GCE', async () => {
      assert.notStrictEqual(true, auth.isGCE);
      const scope = nockNotGCE();
      await auth._checkIsGCE();
      assert.strictEqual(false, auth.isGCE);
      await auth._checkIsGCE();
      assert.strictEqual(false, auth.isGCE);
      scope.done();
    });

    it('getCredentials should get metadata from the server when running on GCE', async () => {
      const response = {
        default: {
          email: 'test-creds@test-creds.iam.gserviceaccount.com',
          private_key: null,
        },
      };
      const scopes = [
        nockIsGCE(),
        createGetProjectIdNock(),
        nock(host).get(svcAccountPath).reply(200, response, HEADERS),
      ];
      await auth._checkIsGCE();
      assert.strictEqual(true, auth.isGCE);
      const body = await auth.getCredentials();
      assert.ok(body);
      assert.strictEqual(
        body.client_email,
        'test-creds@test-creds.iam.gserviceaccount.com'
      );
      assert.strictEqual(body.private_key, undefined);
      scopes.forEach(s => s.done());
    });

    it('getCredentials should error if metadata server is not reachable', async () => {
      const scopes = [
        nockIsGCE(),
        createGetProjectIdNock(),
        nock(HOST_ADDRESS).get(svcAccountPath).reply(404),
      ];
      await auth._checkIsGCE();
      assert.strictEqual(true, auth.isGCE);
      await assert.rejects(
        auth.getCredentials(),
        /Unsuccessful response status code. Request failed with status code 404/
      );
      scopes.forEach(s => s.done());
    });

    it('getCredentials should error if body is empty', async () => {
      const scopes = [
        nockIsGCE(),
        createGetProjectIdNock(),
        nock(HOST_ADDRESS).get(svcAccountPath).reply(200, {}),
      ];
      await auth._checkIsGCE();
      assert.strictEqual(true, auth.isGCE);
      await assert.rejects(
        auth.getCredentials(),
        /Invalid response from metadata service: incorrect Metadata-Flavor header./
      );
      scopes.forEach(s => s.done());
    });

    it('getCredentials should handle valid environment variable', async () => {
      // Set up a mock to return path to a valid credentials file.
      mockEnvVar(
        'GOOGLE_APPLICATION_CREDENTIALS',
        './test/fixtures/private.json'
      );
      const result = await auth._tryGetApplicationCredentialsFromEnvironmentVariable();
      assert(result);
      const jwt = result as JWT;
      const body = await auth.getCredentials();
      assert.notStrictEqual(null, body);
      assert.strictEqual(jwt.email, body.client_email);
      assert.strictEqual(jwt.key, body.private_key);
    });

    it('getCredentials should call getClient to load credentials', async () => {
      // Set up a mock to return path to a valid credentials file.
      mockEnvVar(
        'GOOGLE_APPLICATION_CREDENTIALS',
        './test/fixtures/private.json'
      );

      const spy = sinon.spy(auth, 'getClient');
      const body = await auth.getCredentials();

      const result = await auth._tryGetApplicationCredentialsFromEnvironmentVariable();
      if (!(result instanceof JWT)) {
        throw new assert.AssertionError({
          message: 'Credentials are not a JWT object',
        });
      }

      assert.notStrictEqual(null, body);
      assert(spy.calledOnce);
      assert.strictEqual(result.email, body!.client_email);
      assert.strictEqual(result.key, body!.private_key);
    });

    it('getCredentials should handle valid file path', async () => {
      // Set up a mock to return path to a valid credentials file.
      mockWindows();
      auth._checkIsGCE = () => Promise.resolve(true);
      mockWindowsWellKnownFile();
      const result = await auth.getApplicationDefault();
      assert(result);
      const jwt = result.credential as JWT;
      const body = await auth.getCredentials();
      assert.notStrictEqual(null, body);
      assert.strictEqual(jwt.email, body!.client_email);
      assert.strictEqual(jwt.key, body!.private_key);
    });

    it('getCredentials should return error when env const is not set', async () => {
      // Set up a mock to return a null path string
      const client = await auth._tryGetApplicationCredentialsFromEnvironmentVariable();
      assert.strictEqual(null, client);
      await assert.rejects(auth.getCredentials());
    });

    it('should use jsonContent if available', async () => {
      const json = createJwtJSON();
      const auth = new GoogleAuth({credentials: json});
      // We know this returned a cached result if a nock scope isn't required
      const body = await auth.getCredentials();
      assert.notStrictEqual(body, null);
      assert.strictEqual(body!.client_email, 'hello@youarecool.com');
    });

    it('should accept keyFilename to get a client', async () => {
      const auth = new GoogleAuth({
        keyFilename: './test/fixtures/private.json',
      });
      const client = (await auth.getClient()) as JWT;
      assert.strictEqual(client.email, 'hello@youarecool.com');
    });

    it('should error when invalid keyFilename passed to getClient', async () => {
      const auth = new GoogleAuth({keyFilename: './funky/fresh.json'});
      await assert.rejects(
        auth.getClient(),
        /ENOENT: no such file or directory/
      );
    });

    it('should accept credentials to get a client', async () => {
      const auth = new GoogleAuth({credentials: privateJSON});
      const client = (await auth.getClient()) as JWT;
      assert.strictEqual(client.email, 'hello@youarecool.com');
    });

    it('should prefer credentials over keyFilename', async () => {
      const credentials: CredentialBody = Object.assign({}, privateJSON, {
        client_email: 'hello@butiamcooler.com',
      });
      const auth = new GoogleAuth({
        credentials,
        keyFilename: './test/fixtures/private.json',
      });
      const client = (await auth.getClient()) as JWT;
      assert.strictEqual(client.email, credentials.client_email);
    });

    it('should allow passing scopes to get a client', async () => {
      const scopes = ['http://examples.com/is/a/scope'];
      const keyFilename = './test/fixtures/private.json';
      const auth = new GoogleAuth({scopes, keyFilename});
      const client = (await auth.getClient()) as JWT;
      assert.strictEqual(client.scopes, scopes);
    });

    it('should allow passing a scope to get a client', async () => {
      const scopes = 'http://examples.com/is/a/scope';
      const keyFilename = './test/fixtures/private.json';
      const auth = new GoogleAuth({scopes, keyFilename});
      const client = (await auth.getClient()) as JWT;
      assert.strictEqual(client.scopes, scopes);
    });

    it('should allow passing a scope to get a Compute client', async () => {
      const scopes = ['http://examples.com/is/a/scope'];
      const nockScopes = [nockIsGCE(), createGetProjectIdNock()];
      const auth = new GoogleAuth({scopes});
      const client = (await auth.getClient()) as Compute;
      assert.strictEqual(client.scopes, scopes);
      nockScopes.forEach(x => x.done());
    });

    it('should get an access token', async () => {
      const {auth, scopes} = mockGCE();
      scopes.push(createGetProjectIdNock());
      const token = await auth.getAccessToken();
      scopes.forEach(s => s.done());
      assert.strictEqual(token, 'abc123');
    });

    it('should get request headers', async () => {
      const {auth, scopes} = mockGCE();
      scopes.push(createGetProjectIdNock());
      const headers = await auth.getRequestHeaders();
      scopes.forEach(s => s.done());
      assert.deepStrictEqual(headers, {Authorization: 'Bearer abc123'});
    });

    it('should authorize the request', async () => {
      const {auth, scopes} = mockGCE();
      scopes.push(createGetProjectIdNock());
      const opts = await auth.authorizeRequest({url: 'http://example.com'});
      scopes.forEach(s => s.done());
      assert.deepStrictEqual(opts.headers, {Authorization: 'Bearer abc123'});
    });

    it('should get the current environment if GCE', async () => {
      envDetect.clear();
      const {auth, scopes} = mockGCE();
      const env = await auth.getEnv();
      assert.strictEqual(env, envDetect.GCPEnv.COMPUTE_ENGINE);
    });

    it('should get the current environment if GKE', async () => {
      envDetect.clear();
      const {auth, scopes} = mockGCE();
      const scope = nock(host)
        .get(`${instancePath}/attributes/cluster-name`)
        .reply(200, {}, HEADERS);
      const env = await auth.getEnv();
      assert.strictEqual(env, envDetect.GCPEnv.KUBERNETES_ENGINE);
      scope.done();
    });

    it('should cache prior call to getEnv(), when GCE', async () => {
      envDetect.clear();
      const {auth, scopes} = mockGCE();
      auth.getEnv();
      const env = await auth.getEnv();
      assert.strictEqual(env, envDetect.GCPEnv.COMPUTE_ENGINE);
    });

    it('should cache prior call to getEnv(), when GKE', async () => {
      envDetect.clear();
      const {auth, scopes} = mockGCE();
      const scope = nock(host)
        .get(`${instancePath}/attributes/cluster-name`)
        .reply(200, {}, HEADERS);
      auth.getEnv();
      const env = await auth.getEnv();
      assert.strictEqual(env, envDetect.GCPEnv.KUBERNETES_ENGINE);
      scope.done();
    });

    it('should get the current environment if GCF 8 and below', async () => {
      envDetect.clear();
      mockEnvVar('FUNCTION_NAME', 'DOGGY');
      const env = await auth.getEnv();
      assert.strictEqual(env, envDetect.GCPEnv.CLOUD_FUNCTIONS);
    });

    it('should get the current environment if GCF 10 and up', async () => {
      envDetect.clear();
      mockEnvVar('FUNCTION_TARGET', 'KITTY');
      const env = await auth.getEnv();
      assert.strictEqual(env, envDetect.GCPEnv.CLOUD_FUNCTIONS);
    });

    it('should get the current environment if GAE', async () => {
      envDetect.clear();
      mockEnvVar('GAE_SERVICE', 'KITTY');
      const env = await auth.getEnv();
      assert.strictEqual(env, envDetect.GCPEnv.APP_ENGINE);
    });

    it('should make the request', async () => {
      const url = 'http://example.com';
      const {auth, scopes} = mockGCE();
      scopes.push(createGetProjectIdNock());
      const data = {breakfast: 'coffee'};
      scopes.push(nock(url).get('/').reply(200, data));
      const res = await auth.request({url});
      scopes.forEach(s => s.done());
      assert.deepStrictEqual(res.data, data);
    });

    it('sign should use the private key for JWT clients', async () => {
      const data = 'abc123';
      const auth = new GoogleAuth({
        credentials: {
          client_email: 'google@auth.library',
          private_key: privateKey,
        },
      });
      const value = await auth.sign(data);
      const sign = crypto.createSign('RSA-SHA256');
      sign.update(data);
      const computed = sign.sign(privateKey, 'base64');
      assert.strictEqual(value, computed);
    });

    it('sign should hit the IAM endpoint if no private_key is available', async () => {
      const {auth, scopes} = mockGCE();
      mockEnvVar('GCLOUD_PROJECT', STUB_PROJECT);
      const email = 'google@auth.library';
      const iamUri = `https://iamcredentials.googleapis.com`;
      const iamPath = `/v1/projects/-/serviceAccounts/${email}:signBlob`;
      const signedBlob = 'erutangis';
      const data = 'abc123';
      scopes.push(
        nock(iamUri).post(iamPath).reply(200, {signedBlob}),
        nock(host)
          .get(svcAccountPath)
          .reply(200, {default: {email, private_key: privateKey}}, HEADERS)
      );
      const value = await auth.sign(data);
      scopes.forEach(x => x.done());
      assert.strictEqual(value, signedBlob);
    });

    it('should pass options to the JWT constructor via constructor', async () => {
      const subject = 'science!';
      const auth = new GoogleAuth({
        keyFilename: './test/fixtures/private.json',
        clientOptions: {subject},
      });
      const client = (await auth.getClient()) as JWT;
      assert.strictEqual(client.subject, subject);
    });

    it('should throw if getProjectId cannot find a projectId', async () => {
      // tslint:disable-next-line no-any
      sinon.stub(auth as any, 'getDefaultServiceProjectId').resolves();
      await assert.rejects(
        auth.getProjectId(),
        /Unable to detect a Project Id in the current environment/
      );
    });

    it('should throw if options are passed to getClient()', async () => {
      const auth = new GoogleAuth();
      await assert.rejects(
        auth.getClient({hello: 'world'}),
        /Passing options to getClient is forbidden in v5.0.0/
      );
    });

    it('getRequestHeaders populates x-goog-user-project with quota_project if present', async () => {
      const tokenReq = mockApplicationDefaultCredentials(
        './test/fixtures/config-with-quota'
      );
      const auth = new GoogleAuth();
      const headers = await auth.getRequestHeaders();
      assert.strictEqual(headers['x-goog-user-project'], 'my-quota-project');
      tokenReq.done();
    });

    it('getRequestHeaders does not populate x-goog-user-project if quota_project is not present', async () => {
      const tokenReq = mockApplicationDefaultCredentials(
        './test/fixtures/config-no-quota'
      );
      const auth = new GoogleAuth();
      const headers = await auth.getRequestHeaders();
      assert.strictEqual(headers['x-goog-user-project'], undefined);
      tokenReq.done();
    });

    it('getRequestHeaders populates x-goog-user-project when called on returned client', async () => {
      const tokenReq = mockApplicationDefaultCredentials(
        './test/fixtures/config-with-quota'
      );
      const auth = new GoogleAuth();
      const client = await auth.getClient();
      assert(client instanceof UserRefreshClient);
      const headers = await client.getRequestHeaders();
      assert.strictEqual(headers['x-goog-user-project'], 'my-quota-project');
      tokenReq.done();
    });

    it('populates x-goog-user-project when request is made', async () => {
      const tokenReq = mockApplicationDefaultCredentials(
        './test/fixtures/config-with-quota'
      );
      const auth = new GoogleAuth();
      const client = await auth.getClient();
      assert(client instanceof UserRefreshClient);
      const apiReq = nock(BASE_URL)
        .post(ENDPOINT)
        .reply(function (uri) {
          assert.strictEqual(
            this.req.headers['x-goog-user-project'][0],
            'my-quota-project'
          );
          return [200, RESPONSE_BODY];
        });
      const res = await client.request({
        url: BASE_URL + ENDPOINT,
        method: 'POST',
        data: {test: true},
      });
      assert.strictEqual(RESPONSE_BODY, res.data);
      tokenReq.done();
      apiReq.done();
    });

    it('should return a Compute client for getIdTokenClient', async () => {
      const nockScopes = [nockIsGCE(), createGetProjectIdNock()];
      const auth = new GoogleAuth();
      const client = await auth.getIdTokenClient('a-target-audience');
      assert(client instanceof IdTokenClient);
      assert(client.idTokenProvider instanceof Compute);
    });

    it('should return a JWT client for getIdTokenClient', async () => {
      // Set up a mock to return path to a valid credentials file.
      mockEnvVar(
        'GOOGLE_APPLICATION_CREDENTIALS',
        './test/fixtures/private.json'
      );

      const auth = new GoogleAuth();
      const client = await auth.getIdTokenClient('a-target-audience');
      assert(client instanceof IdTokenClient);
      assert(client.idTokenProvider instanceof JWT);
    });

    it('should call getClient for getIdTokenClient', async () => {
      // Set up a mock to return path to a valid credentials file.
      mockEnvVar(
        'GOOGLE_APPLICATION_CREDENTIALS',
        './test/fixtures/private.json'
      );

      const spy = sinon.spy(auth, 'getClient');
      const client = await auth.getIdTokenClient('a-target-audience');
      assert(client instanceof IdTokenClient);
      assert(spy.calledOnce);
    });

    it('should fail when using UserRefreshClient', async () => {
      // Set up a mock to return path to a valid credentials file.
      mockEnvVar(
        'GOOGLE_APPLICATION_CREDENTIALS',
        './test/fixtures/refresh.json'
      );
      mockEnvVar('GOOGLE_CLOUD_PROJECT', 'some-project-id');

      try {
        const client = await auth.getIdTokenClient('a-target-audience');
      } catch (e) {
        assert(
          e.message.startsWith('Cannot fetch ID token in this environment')
        );
        return;
      }
      assert.fail('failed to throw');
    });

    function mockApplicationDefaultCredentials(path: string) {
      // Fake a home directory in our fixtures path.
      mockEnvVar('GCLOUD_PROJECT', 'my-fake-project');
      mockEnvVar('HOME', path);
      mockEnvVar('APPDATA', `${path}/.config`);
      // The first time auth.getClient() is called /token endpoint is used to
      // fetch a JWT.
      return nock('https://oauth2.googleapis.com')
        .post('/token')
        .reply(200, {});
    }
  });
});

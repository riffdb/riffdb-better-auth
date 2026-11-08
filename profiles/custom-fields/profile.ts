// Generated profile binding. Review sources, then run riffdb application lock --write.
import { defineRiffDBCompiledProfile } from "@riffdb/better-auth";
import * as bindings from "./src/generated/client.js";
export default defineRiffDBCompiledProfile({
  plan: {
  "schema": "riffdb.better-auth-profile-plan/v1",
  "betterAuthVersion": "1.7.18",
  "idGeneration": "uuid",
  "name": "BetterAuthCustomFields",
  "contract": {
    "lineage": "BetterAuthCustomFields",
    "applicationRole": "BetterAuthServer"
  },
  "plugins": [],
  "models": [
    {
      "name": "account",
      "storageName": "account",
      "fields": [
        {
          "name": "accessToken",
          "storageName": "accessToken",
          "type": "string",
          "required": false,
          "unique": false,
          "indexed": false,
          "secret": true,
          "input": true,
          "returned": false,
          "hasDefault": false,
          "hasOnUpdate": false
        },
        {
          "name": "accessTokenExpiresAt",
          "storageName": "accessTokenExpiresAt",
          "type": "date",
          "required": false,
          "unique": false,
          "indexed": false,
          "secret": true,
          "input": true,
          "returned": false,
          "hasDefault": false,
          "hasOnUpdate": false
        },
        {
          "name": "accountId",
          "storageName": "accountId",
          "type": "string",
          "required": true,
          "unique": false,
          "indexed": false,
          "secret": false,
          "input": true,
          "returned": true,
          "hasDefault": false,
          "hasOnUpdate": false
        },
        {
          "name": "createdAt",
          "storageName": "createdAt",
          "type": "date",
          "required": true,
          "unique": false,
          "indexed": false,
          "secret": false,
          "input": true,
          "returned": true,
          "hasDefault": true,
          "hasOnUpdate": false
        },
        {
          "name": "idToken",
          "storageName": "idToken",
          "type": "string",
          "required": false,
          "unique": false,
          "indexed": false,
          "secret": true,
          "input": true,
          "returned": false,
          "hasDefault": false,
          "hasOnUpdate": false
        },
        {
          "name": "password",
          "storageName": "password",
          "type": "string",
          "required": false,
          "unique": false,
          "indexed": false,
          "secret": true,
          "input": true,
          "returned": false,
          "hasDefault": false,
          "hasOnUpdate": false
        },
        {
          "name": "providerId",
          "storageName": "providerId",
          "type": "string",
          "required": true,
          "unique": false,
          "indexed": false,
          "secret": false,
          "input": true,
          "returned": true,
          "hasDefault": false,
          "hasOnUpdate": false
        },
        {
          "name": "refreshToken",
          "storageName": "refreshToken",
          "type": "string",
          "required": false,
          "unique": false,
          "indexed": false,
          "secret": true,
          "input": true,
          "returned": false,
          "hasDefault": false,
          "hasOnUpdate": false
        },
        {
          "name": "refreshTokenExpiresAt",
          "storageName": "refreshTokenExpiresAt",
          "type": "date",
          "required": false,
          "unique": false,
          "indexed": false,
          "secret": true,
          "input": true,
          "returned": false,
          "hasDefault": false,
          "hasOnUpdate": false
        },
        {
          "name": "scope",
          "storageName": "scope",
          "type": "string",
          "required": false,
          "unique": false,
          "indexed": false,
          "secret": false,
          "input": true,
          "returned": true,
          "hasDefault": false,
          "hasOnUpdate": false
        },
        {
          "name": "updatedAt",
          "storageName": "updatedAt",
          "type": "date",
          "required": true,
          "unique": false,
          "indexed": false,
          "secret": false,
          "input": true,
          "returned": true,
          "hasDefault": false,
          "hasOnUpdate": true
        },
        {
          "name": "userId",
          "storageName": "userId",
          "type": "string",
          "required": true,
          "unique": false,
          "indexed": true,
          "secret": false,
          "input": true,
          "returned": true,
          "hasDefault": false,
          "hasOnUpdate": false,
          "reference": {
            "model": "user",
            "field": "id",
            "onDelete": "cascade"
          }
        }
      ]
    },
    {
      "name": "session",
      "storageName": "session",
      "fields": [
        {
          "name": "createdAt",
          "storageName": "createdAt",
          "type": "date",
          "required": true,
          "unique": false,
          "indexed": false,
          "secret": false,
          "input": true,
          "returned": true,
          "hasDefault": true,
          "hasOnUpdate": false
        },
        {
          "name": "expiresAt",
          "storageName": "expiresAt",
          "type": "date",
          "required": true,
          "unique": false,
          "indexed": false,
          "secret": false,
          "input": true,
          "returned": true,
          "hasDefault": false,
          "hasOnUpdate": false
        },
        {
          "name": "ipAddress",
          "storageName": "ipAddress",
          "type": "string",
          "required": false,
          "unique": false,
          "indexed": false,
          "secret": false,
          "input": true,
          "returned": true,
          "hasDefault": false,
          "hasOnUpdate": false
        },
        {
          "name": "token",
          "storageName": "token",
          "type": "string",
          "required": true,
          "unique": true,
          "indexed": false,
          "secret": true,
          "input": true,
          "returned": true,
          "hasDefault": false,
          "hasOnUpdate": false
        },
        {
          "name": "updatedAt",
          "storageName": "updatedAt",
          "type": "date",
          "required": true,
          "unique": false,
          "indexed": false,
          "secret": false,
          "input": true,
          "returned": true,
          "hasDefault": false,
          "hasOnUpdate": true
        },
        {
          "name": "userAgent",
          "storageName": "userAgent",
          "type": "string",
          "required": false,
          "unique": false,
          "indexed": false,
          "secret": false,
          "input": true,
          "returned": true,
          "hasDefault": false,
          "hasOnUpdate": false
        },
        {
          "name": "userId",
          "storageName": "userId",
          "type": "string",
          "required": true,
          "unique": false,
          "indexed": true,
          "secret": false,
          "input": true,
          "returned": true,
          "hasDefault": false,
          "hasOnUpdate": false,
          "reference": {
            "model": "user",
            "field": "id",
            "onDelete": "cascade"
          }
        }
      ]
    },
    {
      "name": "user",
      "storageName": "user",
      "fields": [
        {
          "name": "createdAt",
          "storageName": "createdAt",
          "type": "date",
          "required": true,
          "unique": false,
          "indexed": false,
          "secret": false,
          "input": true,
          "returned": true,
          "hasDefault": true,
          "hasOnUpdate": false
        },
        {
          "name": "dateField",
          "storageName": "dateField",
          "type": "date",
          "required": false,
          "unique": false,
          "indexed": false,
          "secret": false,
          "input": true,
          "returned": true,
          "hasDefault": false,
          "hasOnUpdate": false
        },
        {
          "name": "email",
          "storageName": "email",
          "type": "string",
          "required": true,
          "unique": true,
          "indexed": false,
          "secret": false,
          "input": true,
          "returned": true,
          "hasDefault": false,
          "hasOnUpdate": false
        },
        {
          "name": "emailVerified",
          "storageName": "emailVerified",
          "type": "boolean",
          "required": true,
          "unique": false,
          "indexed": false,
          "secret": false,
          "input": false,
          "returned": true,
          "hasDefault": true,
          "hasOnUpdate": false
        },
        {
          "name": "image",
          "storageName": "image",
          "type": "string",
          "required": false,
          "unique": false,
          "indexed": false,
          "secret": false,
          "input": true,
          "returned": true,
          "hasDefault": false,
          "hasOnUpdate": false
        },
        {
          "name": "locale",
          "storageName": "locale",
          "type": "string",
          "required": false,
          "unique": false,
          "indexed": false,
          "secret": false,
          "input": true,
          "returned": true,
          "hasDefault": false,
          "hasOnUpdate": false
        },
        {
          "name": "name",
          "storageName": "name",
          "type": "string",
          "required": true,
          "unique": false,
          "indexed": false,
          "secret": false,
          "input": true,
          "returned": true,
          "hasDefault": false,
          "hasOnUpdate": false
        },
        {
          "name": "updatedAt",
          "storageName": "updatedAt",
          "type": "date",
          "required": true,
          "unique": false,
          "indexed": false,
          "secret": false,
          "input": true,
          "returned": true,
          "hasDefault": true,
          "hasOnUpdate": true
        }
      ]
    },
    {
      "name": "verification",
      "storageName": "verification",
      "fields": [
        {
          "name": "createdAt",
          "storageName": "createdAt",
          "type": "date",
          "required": true,
          "unique": false,
          "indexed": false,
          "secret": false,
          "input": true,
          "returned": true,
          "hasDefault": true,
          "hasOnUpdate": false
        },
        {
          "name": "expiresAt",
          "storageName": "expiresAt",
          "type": "date",
          "required": true,
          "unique": false,
          "indexed": false,
          "secret": false,
          "input": true,
          "returned": true,
          "hasDefault": false,
          "hasOnUpdate": false
        },
        {
          "name": "identifier",
          "storageName": "identifier",
          "type": "string",
          "required": true,
          "unique": false,
          "indexed": true,
          "secret": false,
          "input": true,
          "returned": true,
          "hasDefault": false,
          "hasOnUpdate": false
        },
        {
          "name": "updatedAt",
          "storageName": "updatedAt",
          "type": "date",
          "required": true,
          "unique": false,
          "indexed": false,
          "secret": false,
          "input": true,
          "returned": true,
          "hasDefault": true,
          "hasOnUpdate": true
        },
        {
          "name": "value",
          "storageName": "value",
          "type": "string",
          "required": true,
          "unique": false,
          "indexed": false,
          "secret": true,
          "input": true,
          "returned": true,
          "hasDefault": false,
          "hasOnUpdate": false
        }
      ]
    }
  ],
  "bounds": {
    "maximumModels": 32,
    "maximumFieldsPerModel": 64
  }
},
  queries: [],
  bindings,
});

import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { delay } from "https://deno.land/std@0.224.0/async/delay.ts";
import { handler } from "../index.js";

const TEST_PORT = 8988;
const TEST_HOST = "127.0.0.1";
const BASE_URL = `http://${TEST_HOST}:${TEST_PORT}`;

// Authorization header required by the server
const AUTH_HEADER = {
  "Authorization": "Basic Rld4dllYOHgwOGFfWGllV3RBbVBpbEQ1NUxVOg==",
};

// Helper function to make HTTP requests
async function query(
  path: string,
  options: RequestInit = {},
): Promise<Response> {
  const url = `${BASE_URL}/${path}`;
  const requestOptions = {
    ...options,
    headers: {
      ...AUTH_HEADER,
      ...(options.headers || {}),
    },
  };
  const response = await fetch(url, requestOptions);
  return response;
}

// Helper to clean up response bodies
async function cleanupResponse(response: Response) {
  try {
    if (!response.bodyUsed) {
      await response.body?.cancel();
    }
  } catch {
    // Ignore errors during cleanup
  }
}

// Start server before running tests
function startTestServer() {
  const controller = new AbortController();
  const serverPromise = serve(handler, {
    port: TEST_PORT,
    signal: controller.signal,
  });
  return {
    controller,
    serverPromise,
  };
}

Deno.test({
  name: "Basic JSON Tests",
  async fn(t) {
    const { controller, serverPromise } = startTestServer();

    try {
      await t.step("SET command returns correct JSON response", async () => {
        const delResponse = await query("DEL/hello");
        await cleanupResponse(delResponse);

        const response = await query("SET/hello/world");
        assertEquals(response.headers.get("Content-Type"), "application/json");
        const data = await response.json();
        assertEquals(data, { SET: {} });
        await cleanupResponse(response);
      });

      await t.step("GET command returns correct JSON response", async () => {
        const setResponse = await query("SET/hello/world");
        await cleanupResponse(setResponse);

        const response = await query("GET/hello");
        assertEquals(response.headers.get("Content-Type"), "application/json");
        const data = await response.json();
        assertEquals(data, { GET: "world" });
        await cleanupResponse(response);
      });

      await t.step("INCR command returns correct JSON response", async () => {
        const delResponse = await query("DEL/hello");
        await cleanupResponse(delResponse);

        const response = await query("INCR/hello");
        assertEquals(response.headers.get("Content-Type"), "application/json");
        const data = await response.json();
        assertEquals(data, { INCR: 1 });
        await cleanupResponse(response);
      });

      await t.step("List operations return correct JSON response", async () => {
        const delResponse = await query("DEL/hello");
        await cleanupResponse(delResponse);

        const rpush1 = await query("RPUSH/hello/abc");
        await cleanupResponse(rpush1);
        const rpush2 = await query("RPUSH/hello/def");
        await cleanupResponse(rpush2);

        const response = await query("LRANGE/hello/0/-1");
        assertEquals(response.headers.get("Content-Type"), "application/json");
        const data = await response.json();
        assertEquals(data, { LRANGE: { abc: "def" } });
        await cleanupResponse(response);
      });

      await t.step("Error returns correct JSON response", async () => {
        const response = await query("UNKNOWN/COMMAND");
        assertEquals(response.headers.get("Content-Type"), "application/json");
        const data = await response.json();
        console.log("Error returns correct JSON response", data);
        assertEquals(typeof data.UNKNOWN, "object");
        await cleanupResponse(response);
      });
    } finally {
      controller.abort();
      await serverPromise;
      await delay(100);
    }
  },
  sanitizeResources: false,
  sanitizeOps: false,
});

Deno.test({
  name: "Database Switch Tests",
  async fn(t) {
    const { controller, serverPromise } = startTestServer();

    try {
      await t.step("Can switch between databases", async () => {
        const set1 = await query("0/SET/key/val0");
        await cleanupResponse(set1);
        const set2 = await query("1/SET/key/val1");
        await cleanupResponse(set2);

        let response = await query("0/GET/key");
        let data = await response.json();
        assertEquals(data.GET, "val0");
        await cleanupResponse(response);

        response = await query("1/GET/key");
        data = await response.json();
        assertEquals(data.GET, "val1");
        await cleanupResponse(response);

        response = await query("GET/key");
        data = await response.json();
        assertEquals(data.GET, "val0");
        await cleanupResponse(response);
      });
    } finally {
      controller.abort();
      await serverPromise;
      await delay(100);
    }
  },
  sanitizeResources: false,
  sanitizeOps: false,
});

Deno.test({
  name: "Redis Hash and Script Commands",
  async fn(t) {
    const { controller, serverPromise } = startTestServer();

    try {
      await t.step("HSET command returns correct JSON response", async () => {
        const delResponse = await query("DEL/myhash");
        await cleanupResponse(delResponse);

        const response = await query("HSET/myhash/field1/value1");
        assertEquals(response.headers.get("Content-Type"), "application/json");
        const data = await response.json();
        assertEquals(data, { HSET: 1 }); // Returns number of fields added
        await cleanupResponse(response);
      });

      await t.step("HGET command returns correct JSON response", async () => {
        const response = await query("HGET/myhash/field1");
        assertEquals(response.headers.get("Content-Type"), "application/json");
        const data = await response.json();
        assertEquals(data, { HGET: "value1" });
        await cleanupResponse(response);
      });

      await t.step("HMSET command returns correct JSON response", async () => {
        const response = await query(
          "HMSET/myhash/field2/value2/field3/value3",
        );
        assertEquals(response.headers.get("Content-Type"), "application/json");
        const data = await response.json();
        assertEquals(data, { HMSET: {} }); // Returns OK as empty object
        await cleanupResponse(response);
      });

      await t.step("HMGET command returns correct JSON response", async () => {
        const response = await query("HMGET/myhash/field1/field2/field3");
        assertEquals(response.headers.get("Content-Type"), "application/json");
        const data = await response.json();
        assertEquals(data, { HMGET: ["value1", "value2", "value3"] });
        await cleanupResponse(response);
      });

      await t.step(
        "EVALSHA command returns correct JSON response",
        async () => {
          // First, we need to load a script with SCRIPT LOAD
          const script = "return {KEYS[1],ARGV[1]}"; // Simple script that returns the key and argument
          const loadResponse = await query(`SCRIPT/LOAD/${script}`);
          const loadData = await loadResponse.json();
          await cleanupResponse(loadResponse);

          // Get the SHA from the response
          const sha = loadData.SCRIPT;
          console.log("SHA of test script:", sha);
          // Now we can use EVALSHA
          // Format: EVALSHA/sha/numkeys/key1/arg1
          const response = await query(`EVALSHA/${sha}/1/testkey/testarg`);
          assertEquals(
            response.headers.get("Content-Type"),
            "application/json",
          );
          const data = await response.json();
          console.log("EVALSHA response:", data);
          assertEquals(data, { EVALSHA: { testkey: "testarg" } });
          // Delete the script
          const delResponse = await query(`SCRIPT/DEL/${sha}`);
          await cleanupResponse(delResponse);
        },
      );

      await t.step(
        "EVALSHA with invalid SHA returns empty object",
        async () => {
          const response = await query(
            "EVALSHA/invalidsha123/1/testkey/testarg",
          );
          assertEquals(
            response.headers.get("Content-Type"),
            "application/json",
          );
          const data = await response.json();
          console.log("EVALSHA error response:", data);
          assertEquals(data, { EVALSHA: {} });
          await cleanupResponse(response);
        },
      );
    } finally {
      controller.abort();
      await serverPromise;
      await delay(100);
    }
  },
  sanitizeResources: false,
  sanitizeOps: false,
});

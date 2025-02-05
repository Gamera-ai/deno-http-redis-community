# deno-http-redis
Deno HTTP Redis is designed to provide an HTTP interface to Redis making Redis available within Serverless applications such as Vercel, Cloudflare workers etc. It is useful for projects which have a high number of concurrent redis commands as it unlocks significant cost efficiencies at scale over similar cloud solutions like Upstash or AWS ElastiCache. 

Deno HTTP Redis provides a Webdis compatible HTTP interface for Redis however we do not guarantee 1:1 compatibilty at this time.

As the name suggest, deno-http-redis is written in Javascript for the Deno runtime.

## Requirements

The deno runtime. To install Deno run: 
```bash
curl -fsSL https://deno.land/install.sh | sh
```

## Performance
deno-http-redis is single threaded and currently handles around 2k commands per second per instance. Since all http commands are atomic, running multiple instances of deno-http-redis with a load balancer is easily possible and can provide much larger scale.

## Installation & Usage
To run, simply pass your environment variables into deno run and ensure you have the allow-net and allow-env flags set. 

The default http port for incoming connections is 1337 if not specified.

```bash
REDIS_PASSWORD=mypassword REDIS_HOST=127.0.0.1 REDIS_PORT=6379 BASIC_AUTH=mybasicauthpassword deno run --allow-net --allow-env index.js <port>
```

## Testing
A few basic unit tests have been provided

```bash
REDIS_PASSWORD=mypassword REDIS_HOST=127.0.0.1 REDIS_PORT=6379 BASIC_AUTH=mybasicauthpassword deno test --allow-net --allow-env tests/index.test.ts
```

## Compiling to self contained executable
If you would like to build a self contained executable for your target system, simply run the following:

```bash
deno compile --target <target_architecture> --no-npm --allow-net --allow-env index.js 8988
```
Supported Targets Jump to heading

Deno supports cross compiling to the following target architecture:

Windows	x86_64	x86_64-pc-windows-msvc
macOS	x86_64	x86_64-apple-darwin
macOS	ARM64	aarch64-apple-darwin
Linux	x86_64	x86_64-unknown-linux-gnu
Linux	ARM64	aarch64-unknown-linux-gnu

## Authentication

If the BASIC_AUTH environment variable is set, all requests (except PING) will
require Basic Authentication

## JS Helper Scripts as LUA alternatives
Sometimes your serverless application may require a series of multiple redis operations with some additional conditional logic. deno-http-redis provides a mechanism to use the redis evalsha  command to invoke a local javascript script placed in the /scripts folder. If no matching script is found, the evalsha command will be passed along to redis for standard LUA script invocation. 

For example, if you had a 'my_test_script.js' file inside the scripts folder, it could be invoked as follows:

```
curl http://localhost:1337/EVALSHA/my_test_script/1/arg1/arg2/arg3
```

To write a test script, you must export an invoke function and return the desired response. Example:

```
import { redisCommand } from '../redis.js';

export async function invoke(dbNumber, args) {

  // Do some redis lookups here

  // Return your results
  return {}
}
```
Two example scripts are included in the project.

## Request Format

Supports both GET and POST requests. Commands are sent as URL path segments for GET requests, or as plain text for POST requests.

### GET Request Format
Commands and arguments are separated by forward slashes:

```
http://localhost:1337/COMMAND/arg1/arg2/arg3
```

Examples:
```bash
# Set key-value
curl http://localhost:1337/SET/hello/world

# Get value
curl http://localhost:1337/GET/hello

# Hash operations
curl http://localhost:1337/HSET/myhash/field1/value1
curl http://localhost:1337/HMSET/myhash/field1/value1/field2/value2
curl http://localhost:1337/HMGET/myhash/field1/field2

# List operations 
curl http://localhost:1337/RPUSH/mylist/value1
curl http://localhost:1337/LRANGE/mylist/0/-1

# Scripting
curl http://localhost:1337/EVALSHA/sha1hash/1/testkey/testarg
```

### POST Request Format
For POST requests, use the same command format but send it in the request body:

```bash
curl -X POST \
  -d 'COMMAND/arg1/arg2/arg3' \
  -H 'Content-Type: text/plain' \
  http://localhost:1337/
```

### Response Format
All responses are JSON objects with the command name as the key:

```json
{
  "COMMAND": result
}
```

Example responses:
```json
{"SET": {}}                    // Success with no return value
{"GET": "world"}              // String value
{"INCR": 1}                   // Numeric value
{"HSET": 1}                   // Number of fields set
{"HMGET": ["val1", "val2"]}   // Array of values
{"LRANGE": ["item1", "item2"]} // List of items
{"UNKNOWN": {"error": "..."}}  // Error response
```

## Database Selection

You should prefix all your commands with `{db_number}/` to select a specific database. 

Example:

```bash
# Use database 1
curl http://localhost:1337/1/SET/mykey/myvalue

# Default to database 0
curl http://localhost:1337/0/SET/mykey/myvalue
```

## Supported Commands & Examples

### Basic Key-Value Operations

#### SET

```bash
# Request
curl http://localhost:1337/SET/hello/world

# Response
{"SET": {}}
```

#### GET

```bash
# Request
curl http://localhost:1337/GET/hello

# Response
{"GET": "world"}
```

#### DEL

```bash
# Request
curl http://localhost:1337/DEL/hello

# Response
{"DEL": 1}
```

#### INCR

```bash
# Request
curl http://localhost:1337/INCR/counter

# Response
{"INCR": 1}
```

### List Operations

#### RPUSH

```bash
# Request
curl http://localhost:1337/RPUSH/mylist/value1

# Response
{"RPUSH": 1}
```

#### LRANGE

```bash
# Request
curl http://localhost:1337/LRANGE/mylist/0/-1

# Response
{"LRANGE": ["value1", "value2"]}
```

### Hash Operations

#### HSET

```bash
# Request
curl http://localhost:1337/HSET/myhash/field1/value1

# Response
{"HSET": 1}
```

#### HGET

```bash
# Request
curl http://localhost:1337/HGET/myhash/field1

# Response
{"HGET": "value1"}
```

#### HMSET

```bash
# Request
curl http://localhost:1337/HMSET/myhash/field1/value1/field2/value2

# Response
{"HMSET": {}}
```

#### HMGET

```bash
# Request
curl http://localhost:1337/HMGET/myhash/field1/field2

# Response
{"HMGET": ["value1", "value2"]}
```

### Scripting

#### SCRIPT LOAD

```bash
# Request
curl http://localhost:1337/SCRIPT/LOAD/return%20{KEYS[1],ARGV[1]}

# Response
{"SCRIPT": "sha1hash"}
```

#### EVALSHA

```bash
# Request
curl http://localhost:1337/EVALSHA/sha1hash/1/testkey/testarg

# Response
{"EVALSHA": {"testkey": "testarg"}}
```

### Error Handling

All errors are returned as JSON responses with appropriate HTTP status codes:

```bash
# Invalid Command
curl http://localhost:1337/INVALID/key
{"INVALID": {"error": "ERR unknown command"}}

# Unauthorized Request
curl http://localhost:1337/GET/key
{"error": "Unauthorized"}
```

## Security

By default, several Redis commands are disabled for security:

- FLUSHDB
- FLUSHALL
- CONFIG commands
- SAVE
- BGSAVE
- KEYS
- And other administrative commands

## Response Format

All responses are in JSON format with the command name as the key:

```json
{
  "COMMAND_NAME": result
}
```

Where `result` can be:

- Empty object `{}` for successful operations without return value
- String for single value responses
- Number for numeric responses
- Array for list responses
- Object for hash responses

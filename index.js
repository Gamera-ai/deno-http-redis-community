import { redisCommand } from './redis.js';
import { serve } from 'https://deno.land/std@0.224.0/http/server.ts';
import { encodeBase64 } from 'jsr:@std/encoding/base64';
import { handleEvalsha } from './evalsha_handler.js';

const cliArgs = Deno.args;

if ('--help' in cliArgs || '-h' in cliArgs || '-help' in cliArgs || '?' in cliArgs) {
	console.log(
		'Usage: REDIS_PASSWORD=mypassword REDIS_HOST=127.0.0.1 REDIS_PORT=6379 BASIC_AUTH=mybasicauthpassword deno run --allow-net --allow-env index.js <port>'
	);
	Deno.exit(1);
}

let BASIC_AUTH_PASSWORD = Deno.env.get('BASIC_AUTH') || '';

if (BASIC_AUTH_PASSWORD) {
	// Check to see if there is a trailing : in the BASIC_AUTH_PASSWORD, if not add one
	if (!BASIC_AUTH_PASSWORD.endsWith(':')) {
		BASIC_AUTH_PASSWORD = BASIC_AUTH_PASSWORD + ':';
	}
	// Base64 encode the BASIC_AUTH_PASSWORD
	BASIC_AUTH_PASSWORD = encodeBase64(BASIC_AUTH_PASSWORD);
	console.log('BASIC_AUTH_PASSWORD', BASIC_AUTH_PASSWORD);
} else {
	console.log('WARNING: BASIC_AUTH is not set, all requests will be allowed');
}

// port is the port number to listen on.
const port = Deno.args[0] || 1337;

export const handler = async (request) => {
	let body;
	const isGet = request.method === 'GET';

	// Handle both GET and POST requests
	if (isGet) {
		// Extract path from URL, removing the leading slash
		body = new URL(request.url).pathname.substring(1);
	} else if (request.method === 'POST') {
		body = await request.text();
	} else {
		return new Response('Only GET and POST requests are allowed', {
			status: 405,
			headers: new Headers({ 'Content-Type': 'text/plain' })
		});
	}

	// Validate body format
	if (typeof body !== 'string') {
		console.log('Body is not a string');
		return new Response('Bad Request', {
			status: 400,
			headers: new Headers({ 'Content-Type': 'text/plain' })
		});
	}

	// Remove trailing slash if present
	if (body.endsWith('/')) {
		body = body.substring(0, body.length - 1);
	}
	// Uridecode the body for compatibility with webdis
	body = decodeURI(body);

	// If the body doesn't start with a number followed by a slash, prepend "0/"
	if (!/^\d+\//.test(body)) {
		body = '0/' + body;
	}

	// Split the body into an array of strings
	const bodyArray = body.split('/');

	// Ensure we have at least database and command
	if (bodyArray.length < 2) {
		return new Response('Invalid request format', {
			status: 400,
			headers: new Headers({ 'Content-Type': 'text/plain' })
		});
	}

	// Check authorization for both GET and POST unless the command is "PING"
	if (
		request.headers.get('Authorization') !== `Basic ${BASIC_AUTH_PASSWORD}` &&
		bodyArray[1] != 'PING' &&
		BASIC_AUTH_PASSWORD
	) {
		return new Response('Unauthorized', {
			status: 401,
			headers: new Headers({ 'Content-Type': 'text/plain' })
		});
	}

	// Add this new check after bodyArray creation and validation
	if (bodyArray[1].toLowerCase() === 'evalsha') {
		// Extract hash and args
		const dbNumber = bodyArray[0]; // Get database number
		const scriptHash = bodyArray[2];
		const args = bodyArray.slice(3);

		try {
			const result = await handleEvalsha(scriptHash, dbNumber, args);
			return new Response(JSON.stringify({ [bodyArray[1]]: result }), {
				status: 200,
				headers: new Headers({
					'Content-Type': 'application/json',
					'X-Redis-Call': 'EVALSHA'
				})
			});
		} catch (error) {
			// If script not found, fall through to regular Redis handling
			if (!error.message.includes('not found')) {
				return new Response(JSON.stringify({ error: error.message }), {
					status: 400,
					headers: new Headers({
						'Content-Type': 'application/json',
						'X-Redis-Call': 'EVALSHA'
					})
				});
			}
			// Fall through to regular Redis command handling
		}
	}

	// Execute redis command and return response
	const redisResult = await redisCommand(bodyArray[1], bodyArray[0], ...bodyArray.slice(2));

	// Some Wedis commands like HMGET and EVALSHA should always return arrays
	// rather than being converted to objects, even if their elements could be
	// interpreted as key-value pairs. This switch statement identifies those
	// commands that should force array output.
	let forceArray = false;
	switch (bodyArray[1].toLowerCase()) {
		case 'hmget': // HMGET returns array of values for requested fields
			forceArray = true;
			break;
	}

	// Only transform array results into objects if the array elements alternate between
	// field names and values, and we can clearly identify a key-value structure
	let resultValue = redisResult.result;
	if (
		!forceArray &&
		Array.isArray(redisResult.result) &&
		redisResult.result.length % 2 === 0 &&
		redisResult.result.length > 0
	) {
		// Split array into potential keys (even indices) and values (odd indices)
		const keys = redisResult.result.filter((_, i) => i % 2 === 0);
		const values = redisResult.result.filter((_, i) => i % 2 === 1);

		// Check if both keys and values are numeric-like strings
		const isNumeric = (str) => !isNaN(parseFloat(str)) && isFinite(str);
		const allKeysNumeric = keys.every(isNumeric);
		const allValuesNumeric = values.every(isNumeric);

		// Only convert to object if keys are strings and have a different pattern from values
		// AND they're not all numeric-like strings
		const allKeysAreStrings = keys.every((k) => typeof k === 'string');
		const keysAndValuesDiffer = keys.some((key, i) => key !== values[i]);

		if (allKeysAreStrings && keysAndValuesDiffer && !(allKeysNumeric && allValuesNumeric)) {
			resultValue = {};
			for (let i = 0; i < redisResult.result.length; i += 2) {
				resultValue[redisResult.result[i]] = redisResult.result[i + 1];
			}
		}
	}

	// Format response to match Webdis format
	const webdisResponse = {
		[bodyArray[1]]: resultValue
	};
	return new Response(JSON.stringify(webdisResponse), {
		status: redisResult.status || 200,
		headers: new Headers({
			'Content-Type': 'application/json',
			'X-Redis-Call': bodyArray[1]
		})
	});
};

// Only start server if this is the main module
if (import.meta.main) {
	console.log(`deno-http-redis webserver running. Access it at: http://0.0.0.0:${port}/`);
	await serve(handler, { port, hostname: '0.0.0.0' });
	console.log('HTTP webserver stopped.');
}

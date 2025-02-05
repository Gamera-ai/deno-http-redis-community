import { redisCommand } from '../redis.js';

export async function invoke(dbNumber, args) {
	// Get the session ID (first argument is the key)
	const sessionId = args[1];

	// The remaining arguments are key-value pairs followed by expiration time
	// Last argument is expiration time, so we exclude it from pairs
	const keyValuePairs = args.slice(2, -1);
	const expirationTime = args[args.length - 1];

	const pipeline = [];

	// If we have key-value pairs to set
	if (keyValuePairs.length > 0) {
		pipeline.push({
			command: 'hset',
			args: [sessionId, ...keyValuePairs]
		});
	}

	// Always add expire command
	pipeline.push({
		command: 'expire',
		args: [sessionId, expirationTime]
	});

	const responses = await redisCommand('PIPELINE', dbNumber, pipeline);

	// Check if pipeline was successful
	if (!responses.success) {
		throw new Error('Operation failed');
	}

	return 'OK';
}

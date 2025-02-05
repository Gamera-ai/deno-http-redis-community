import { redisCommand } from '../redis.js';

/**
 * Checks which Redis sets contain a specific user ID using pipelined SISMEMBER commands.
 * 
 * @param {number} dbNumber - The Redis database number to use
 * @param {string[]} args - Array of arguments where:
 *   - args[0] is typically unused (reserved for script name in Lua compatibility)
 *   - args[1] is the user ID to check
 *   - args[2...n] are the set names to check for membership
 * 
 * @returns {Promise<string[]>} Array of set names where the user ID is a member
 * @throws {Error} If fewer than 2 arguments are provided
 * 
 */
export async function invoke(dbNumber, args) {
	// Validate input
	if (args.length < 2) {
		throw new Error('Required arguments: <user_id> <set_1> <set_2> ...');
	}

	const user_id = args[1]; // First argument is the user_id (KEYS[1] in Lua)
	const sets = args.slice(2); // Remaining arguments are the sets to check
	const result = [];

	// Pipeline all SISMEMBER commands
	const pipeline = sets.map((set) => ({
		command: 'sismember', // lowercase command name to match redis module methods
		args: [set, user_id]
	}));

	const responses = await redisCommand('PIPELINE', dbNumber, pipeline);

	// Process pipeline responses
	if (responses.success) {
		responses.result.forEach((response, index) => {
			if (response === 1) {
				result.push(sets[index]);
			}
		});
	}

	// Return just the result array to match Lua script behavior
	return result;
}

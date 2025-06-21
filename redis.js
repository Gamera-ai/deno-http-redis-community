import { connect } from 'https://deno.land/x/redis/mod.ts';

const REDIS_AUTH = Deno.env.get('REDIS_PASSWORD') || '';
const REDIS_HOST = Deno.env.get('REDIS_HOST') || '127.0.0.1';
const REDIS_PORT = parseInt(Deno.env.get('REDIS_PORT') || '6379');

// Connection pool configuration
const POOL_SIZE = 10;
const ACQUIRE_TIMEOUT = 10000; // 10 seconds

class RedisConnectionPool {
	// Use private class fields for better encapsulation
	#pools;
	#inUse;
	#cleanupInterval;

	constructor() {
		this.#pools = new Map();
		this.#inUse = new Map();
		// Add cleanup interval
		this.#cleanupInterval = setInterval(() => this.#cleanupStaleConnections(), 60000);
	}

	// Add cleanup method
	async #cleanupStaleConnections() {
		const MAX_IDLE_TIME = 300000; // 5 minutes

		for (const [dbNumber, pool] of this.#pools) {
			const oldPool = new Map(pool);
			for (const [client, lastUsed] of oldPool) {
				if (Date.now() - lastUsed < MAX_IDLE_TIME) {
					// connection is still usable
					continue;
				}

				// connection is stale, ping it
				try {
					await client.ping();
				} catch (error) {
					console.log(`closing stale/dead connection to db ${dbNumber}`);

					// connection is dead, remove it
					pool.delete(client);
					try {
						await client.quit();
					} catch (error) {
						console.error('Error closing stale/dead connection:', error);
					}

					// add a new connection to the pool
					await this.#addConnectionToPool(dbNumber);
				}
			}
		}

		// Cleanup any stuck connections in #inUse
		for (const [client, record] of this.#inUse) {
			if (Date.now() - record.timestamp > ACQUIRE_TIMEOUT) {
				console.log(`closing stuck connection to db ${record.dbNumber}`);

				this.#inUse.delete(client);
				try {
					await client.quit();
				} catch (error) {
					console.error('Error closing stuck connection:', error);
				}

				// add a new connection to the pool
				await this.#addConnectionToPool(record.dbNumber);
			}
		}
	}

	// Add destructor method
	async destroy() {
		clearInterval(this.#cleanupInterval);

		// Close all connections
		for (const [, pool] of this.#pools) {
			for (const [client] of pool) {
				try {
					await client.quit();
				} catch (error) {
					console.error('Error closing connection during cleanup:', error);
				}
			}
		}

		this.#pools.clear();
		this.#inUse.clear();
	}

	async initialize(dbNumber) {
		if (this.#pools.has(dbNumber)) return;

		this.#pools.set(dbNumber, new Map());
		try {
			await Promise.all(
				Array.from({ length: POOL_SIZE }, () => this.#addConnectionToPool(dbNumber))
			);
		} catch (error) {
			console.error(`Failed to initialize connection pool for db ${dbNumber}:`, error);
			throw error;
		}
	}

	// New helper method to reduce code duplication
	async #addConnectionToPool(dbNumber) {
		const client = await this.createConnection(dbNumber);
		this.#pools.get(dbNumber).set(client, Date.now());
		return client;
	}

	async createConnection(dbNumber) {
		if (REDIS_AUTH) {
			return await connect({
				hostname: REDIS_HOST,
				port: REDIS_PORT,
				password: REDIS_AUTH,
				db: dbNumber
			});
		} else {
			return await connect({
				hostname: REDIS_HOST,
				port: REDIS_PORT,
				db: dbNumber
			});
		}
	}

	async acquireConnection(dbNumber) {
		if (!this.#pools.has(dbNumber)) {
			await this.initialize(dbNumber);
		}

		const connection = this.#findAvailableConnection(dbNumber);
		if (connection) {
			return connection;
		}

		return await this.#waitForConnection(dbNumber);
	}

	// Split into smaller, more focused methods
	#findAvailableConnection(dbNumber) {
		const pool = this.#pools.get(dbNumber);
		for (const [client] of pool) {
			if (!this.#inUse.has(client)) {
				pool.delete(client);
				this.#inUse.set(client, { dbNumber, timestamp: Date.now() });
				return client;
			}
		}
		return null;
	}

	async #waitForConnection(dbNumber) {
		const startTime = Date.now();
		while (Date.now() - startTime < ACQUIRE_TIMEOUT) {
			await new Promise((resolve) => setTimeout(resolve, 100));
			const connection = this.#findAvailableConnection(dbNumber);
			if (connection) return connection;
		}
		throw new Error(`Timeout acquiring Redis connection for database ${dbNumber}`);
	}
	// deno-lint-ignore require-await
	async releaseConnection(client, dbNumber) {
		if (this.#inUse.has(client)) {
			this.#inUse.delete(client);
			this.#pools.get(dbNumber).set(client, Date.now());
		}
	}
}

// Create a single pool instance
const connectionPool = new RedisConnectionPool();

// Convert banned commands to a Set for O(1) lookup efficiency
const BANNED_COMMANDS = new Set(
	[
		'flushdb',
		'flushall',
		'dump',
		'configset',
		'config',
		'slaveof',
		'slaveofnoone',
		'replicaof',
		'replicaofnoone',
		'modulelist',
		'moduleload',
		'moduleunload',
		'monitor',
		'memorydoctor',
		'memoryhelp',
		'memorymallocstats',
		'memorypurge',
		'memorystats',
		'memoryusage',
		'shutdown',
		'save',
		'slowlog',
		'sync',
		'scriptdebug',
		'scriptflush',
		'scriptkill',
		'scriptload',
		'scriptexists',
		'bgsave',
		'bgrewriteaof',
		'keys'
	].map((cmd) => cmd.toLowerCase())
);

// For a string formatted as  command/value/key/value/key/value construct a redis command
// and return the result of the command.
export async function redisCommand(command, dbNumber, ...args) {
	let client = null;
	try {
		if (command.toLowerCase() === 'pipeline') {
			return await handlePipelineCommand(dbNumber, args[0]);
		}

		if (BANNED_COMMANDS.has(command.toLowerCase())) {
			return {
				success: false,
				error: 'Command not allowed.',
				status: 403,
				result: {}
			};
		}

		client = await connectionPool.acquireConnection(dbNumber);
		const result = await client.sendCommand(command, args);

		return {
			success: true,
			result: result === 'OK' ? {} : result,
			status: 200
		};
	} catch (error) {
		return {
			success: false,
			error: formatError(error),
			status: 400,
			result: {}
		};
	} finally {
		if (client) {
			await connectionPool.releaseConnection(client, dbNumber);
		}
	}
}

// Helper functions for better organization
function formatError(error) {
	return error
		.toString()
		.split('\n')[0]
		.replace(/\r/g, '')
		.replace(/Error: /, '')
		.replace(/-ERR /, '');
}

async function handlePipelineCommand(dbNumber, commands) {
	const client = await connectionPool.acquireConnection(dbNumber);
	try {
		const pl = client.pipeline();

		for (const { command, args } of commands) {
			if (BANNED_COMMANDS.has(command.toLowerCase())) {
				throw new Error(`Command ${command} not allowed.`);
			}
			pl[command.toLowerCase()](...args);
		}

		const result = await pl.flush();
		return {
			success: true,
			result,
			status: 200
		};
	} catch (error) {
		return {
			success: false,
			error: formatError(error),
			status: 400,
			result: {}
		};
	} finally {
		await connectionPool.releaseConnection(client, dbNumber);
	}
}

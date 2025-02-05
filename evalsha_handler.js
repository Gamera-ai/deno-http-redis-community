async function handleEvalsha(scriptHash, dbNumber, args) {
	try {
		// Import the script module dynamically
		const scriptModule = await import(`./scripts/${scriptHash}.js`);

		// Check if the module has an invoke function
		if (typeof scriptModule.invoke !== 'function') {
			throw new Error(`Script ${scriptHash}.js does not export an invoke function`);
		}

		// Call the invoke function with dbNumber and args
		return await scriptModule.invoke(dbNumber, args);
	} catch (error) {
		if (error.code === 'ERR_MODULE_NOT_FOUND') {
			throw new Error(`Script ${scriptHash} not found. Are you sure it exists?`);
		}
		throw error;
	}
}

export { handleEvalsha };

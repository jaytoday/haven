import {ConnectError, Code, ConnectRouter} from "@bufbuild/connect";
import typia from "typia";

import {Haven} from "./pb/manager_connect";
import {
	ChatCompletionRequest,
	ChatCompletionResponse,
	CreateInferenceWorkerRequest,
	Empty,
	InferenceWorker,
	ListModelsResponse,
	ListWorkersResponse,
	SetupRequest,
} from "./pb/manager_pb";

import {config} from "../lib/config";
import {createComputeAPI, list, pause, remove, start} from "../gcloud/resources";
import {getTransport} from "../lib/client";
import {catchErrors, enforceSetup, auth} from "./middleware";
import {getAllModels} from "../lib/models";
import {setupController} from "../controller/setup";
import {generateController} from "../controller/generate";
import {createInferenceWorkerController} from "../controller/createInferenceWorker";
import {getWorkerIP} from "../lib/workers";
import {validate} from "./validate";
import {listWorkersController} from "../controller/workers";

/////////////////////
// Setup
/////////////////////

const setupInputValid = typia.createAssertEquals<SetupRequest>();

/**
 * Set up the manager by providing the Google Cloud key.
 */
async function setupHandler(req: SetupRequest) {
	if (config.setupDone) {
		// Endpoint is being called as "ping" to check if the setup is done.
		// It is, so we return.
		return;
	}

	const file = req.keyFile;

	if (file === undefined) {
		// Endpoint is being called as "ping" to check if the setup is done.
		// It's not, but we also can't do the setup now, so we throw an error.
		throw new ConnectError("Setup not complete.", Code.FailedPrecondition);
	}

	// Now we can assume that the setup is not done and the user wants to finish it.
	return setupController(file);
}

/////////////////////
// Generate text
/////////////////////

/**
 * Generate text from a prompt.
 */
async function* chatCompletion(req: ChatCompletionRequest) {
	const workerName = req.workerName;
	const messages = req.messages;

	const stream = await generateController(workerName, messages);

	for await (const data of stream) {
		yield new ChatCompletionResponse({text: data.text});
	}
}

/////////////////////
// List models
/////////////////////

const listModelsInputValid = typia.createAssertEquals<Empty>();

/**
 * Get all models that are available for inference.
 */
async function listModels(req: Empty) {
	return getAllModels()
		.then((names) => names.map((name) => ({name})))
		.then((models) => new ListModelsResponse({models}))
		.catch((e) => {
			throw new ConnectError(e.message, Code.Internal);
		});
}

/////////////////////
// List workers
/////////////////////

const listWorkersInputValid = typia.createAssertEquals<Empty>();

/**
 * Get a list of all workers and their status.
 */
async function listWorkers(req: Empty) {
	const workerList = await listWorkersController();

	return new ListWorkersResponse({
		workers: workerList,
	});
}

/////////////////////
// Create inference worker
/////////////////////

const createInferenceWorkerInputValid = typia.createAssertEquals<CreateInferenceWorkerRequest>();

async function createInferenceWorker(req: CreateInferenceWorkerRequest) {
	const modelName = req.modelName;
	let worker = req.workerName;

	const requestedResources = {
		quantization: req.quantization,
		gpuType: req.gpuType,
		gpuCount: req.gpuCount,
	};

	const workerName = await createInferenceWorkerController(modelName, requestedResources, worker);

	return new InferenceWorker({
		workerName,
	});
}

/////////////////////
// Pause worker
/////////////////////

const inferenceWorkerValid = typia.createAssertEquals<InferenceWorker>();

async function pauseWorker(req: InferenceWorker) {
	const workerName = req.workerName;

	// Check if worker exists
	const api = await createComputeAPI();
	const workers = await list(api);
	const worker = workers.find((worker) => worker.name === workerName);

	if (!worker || !worker.name) {
		throw new ConnectError(`Worker ${workerName} does not exist`, Code.NotFound);
	}

	if (getWorkerIP(worker)) {
		await getTransport(getWorkerIP(worker)!)
			.shutdown({})
			.catch((e) => {
				console.error(`Error sending shutdown signal to worker ${workerName}: ${e.message}`);
			});
	}

	await pause(api, worker.name).catch((e) => {
		console.error(e);
		throw new ConnectError(`Failed to pause worker ${workerName}: ${e.message}`, Code.Internal);
	});

	return new InferenceWorker({
		workerName: worker.name,
	});
}

/////////////////////
// Resume worker
/////////////////////

async function resumeWorker(req: InferenceWorker) {
	const workerName = req.workerName;

	// Check if worker exists
	const api = await createComputeAPI();
	const workers = await list(api);
	const worker = workers.find((worker) => worker.name === workerName);

	if (!worker || !worker.name) {
		throw new ConnectError(`Worker ${workerName} does not exist`, Code.NotFound);
	}

	if (worker.status !== "TERMINATED") {
		throw new ConnectError(`Worker ${workerName} is not paused`, Code.FailedPrecondition);
	}

	await start(api, worker.name).catch((e) => {
		console.error(e);
		throw new ConnectError(`Failed to resume worker ${workerName}: ${e.message}`, Code.Internal);
	});

	return new InferenceWorker({
		workerName: worker.name,
	});
}

/////////////////////
// Delete worker
/////////////////////

async function deleteWorker(req: InferenceWorker) {
	const workerName = req.workerName;

	// Check if worker exists
	const api = await createComputeAPI();
	const workers = await list(api);
	const worker = workers.find((worker) => worker.name === workerName);

	if (!worker || !worker.name) {
		throw new ConnectError(`Worker ${workerName} does not exist`, Code.NotFound);
	}

	if (getWorkerIP(worker)) {
		await getTransport(getWorkerIP(worker)!)
			.shutdown({})
			.catch((e) => {
				console.error(`Error sending shutdown signal to worker ${workerName}: ${e.message}`);
			});
	}

	await remove(api, worker.name).catch((e) => {
		console.error(e);
		throw new ConnectError(`Failed to delete worker ${workerName}: ${e.message}`, Code.Internal);
	});

	return new InferenceWorker({
		workerName: worker.name,
	});
}

export const haven = (router: ConnectRouter) =>
	router.service(Haven, {
		setup: catchErrors(validate(setupInputValid, auth(setupHandler))),

		chatCompletion: auth(enforceSetup(chatCompletion)),

		listModels: catchErrors(validate(listModelsInputValid, auth(enforceSetup(listModels)))),
		listWorkers: catchErrors(validate(listWorkersInputValid, auth(enforceSetup(listWorkers)))),

		createInferenceWorker: catchErrors(
			validate(createInferenceWorkerInputValid, auth(enforceSetup(createInferenceWorker))),
		),
		pauseInferenceWorker: catchErrors(validate(inferenceWorkerValid, auth(enforceSetup(pauseWorker)))),
		resumeInferenceWorker: catchErrors(validate(inferenceWorkerValid, auth(enforceSetup(resumeWorker)))),
		deleteInferenceWorker: catchErrors(validate(inferenceWorkerValid, auth(enforceSetup(deleteWorker)))),
	});

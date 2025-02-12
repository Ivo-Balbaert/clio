const asyncHooks = require("async_hooks");
const builtins = require("clio-lang-internals");

const executors = {
  ws: require("./executors/ws"),
  ipc: require("./executors/ipc"),
  tcp: require("./executors/tcp"),
};

class Distributed {
  constructor(isWorker, connection) {
    this.map = new Map();
    this.isWorker = isWorker;
    this.connection = connection;
    this.executors = new Map();
  }
  set(key, fn) {
    this.map.set(key, fn);
    if (this.isWorker) this.connection.register(key, fn);
  }
  get(key) {
    return this.connection.getFunction(key);
  }
  async getExecutor(protocol, host) {
    const key = `${protocol}:${host}`;
    if (this.executors.has(key)) return this.executors.get(key);
    return await executors[protocol].call(this, key, protocol, host);
  }
}

const workerDist = (executor, worker) =>
  new Distributed(true, {
    register(path, fn) {
      return worker.register({ path, fn });
    },
    getFunction(fn) {
      return executor.getFunction(fn);
    },
    getFunctions(path) {
      return executor.getFunctions(path);
    },
  });

const mainDist = (executor) =>
  new Distributed(false, {
    getFunction(fn) {
      return executor.getFunction(fn);
    },
    getFunctions(path) {
      return executor.getFunctions(path);
    },
  });

class Monitor {
  constructor() {
    this.active = new Set();
    this.frozen = new Set();
    const self = this;
    if (!asyncHooks || !asyncHooks.createHook) return;
    this.hook = asyncHooks.createHook({
      init(asyncId, type) {
        if (type === "TIMERWRAP" || type === "PROMISE") return;
        self.active.add(asyncId);
      },
      destroy(asyncId) {
        self.active.delete(asyncId);
        self.checkExit();
      },
    });
    this.hook.enable();
  }
  freeze() {
    if (!asyncHooks || !asyncHooks.createHook) return;
    this.frozen = new Set([...this.active]);
  }
  exit() {
    if (!asyncHooks || !asyncHooks.createHook) return;
    this.shouldExit = true;
    this.checkExit();
  }
  checkExit() {
    if (!asyncHooks || !asyncHooks.createHook) return;
    if (!this.shouldExit) return;
    if ([...this.active].every((handle) => this.frozen.has(handle))) {
      process.exit(0);
    }
  }
}

const run = async (module, { worker, executor }, { noMain = false } = {}) => {
  const clio = {
    distributed: worker ? workerDist(executor, worker) : mainDist(executor),
    isWorker: !!worker,
    isMain: !worker,
    exports: {},
    ...builtins,
  };
  clio.register = (name, fn) => {
    clio.distributed.set(name, fn);
    fn.parallel = clio.distributed.get(name);
    return fn;
  };
  const { main } = await module.exports(clio);
  const argv = typeof process != "undefined" ? process.argv : [];
  if (!worker && !noMain) {
    const result = await main(argv);
    const awaited = Array.isArray(result)
      ? await Promise.all(result)
      : await result;
    return awaited;
  }
};

const importClio = (file) => {
  // This is probably added because of parcel
  const worker_threads = "worker_threads";
  const { Worker } = require(worker_threads);
  const { Dispatcher } = require("clio-rpc/dispatcher");
  const { Executor } = require("clio-rpc/executor");
  const WorkerThread = require("clio-rpc/transports/worker-thread");

  const path = require("path");
  const os = require("os");

  const numCPUs = os.cpus().length;
  const main = require(file);

  const dispatcher = new Dispatcher();
  const serverTransport = new WorkerThread.Server();
  const workerFile = path.resolve(__dirname, "./workers/wt.js");

  for (let i = 0; i < numCPUs; i++) {
    const worker = new Worker(workerFile, { workerData: { file } });
    serverTransport.addWorker(worker);
  }
  dispatcher.addTransport(serverTransport);

  return new Promise((resolve) => {
    dispatcher.expectWorkers(numCPUs).then(async () => {
      const clientTransport = serverTransport.getTransport();
      const executor = new Executor(clientTransport);
      const clio = {
        distributed: mainDist(executor),
        isMain: true,
        isWorker: false,
        exports: {},
        ...builtins,
      };
      const exports = await main.exports(clio);
      resolve({ dispatcher, exports });
    });
  });
};

module.exports.Distributed = Distributed;
module.exports.Monitor = Monitor;

module.exports.run = run;
module.exports.importClio = importClio;

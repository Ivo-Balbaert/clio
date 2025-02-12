const path = require("path");
const fs = require("fs");
const toml = require("@iarna/toml");

const { CONFIGFILE_NAME } = require("./config");

/* Package getters */

/**
 * @param {string} filepath Optional name of file containing the configurations for the clio package in format `foo.toml`.
 */
function getPackageConfig(
  filepath = path.join(process.cwd(), CONFIGFILE_NAME)
) {
  const file = fs.readFileSync(filepath);
  const config = toml.parse(file);

  const parsedConfig = {
    title: config.title,
    description: config.description,
    version: config.version,
    license: config.license,
    main: config.main,
    authors: config.authors,
    keywords: config.keywords,
    build: config.build,
    target: config.target,
    // eslint-disable-next-line camelcase
    git_repository: config.git_repository,
    documentation: config.documentation,
    scripts: config.scripts,
    servers: config.servers,
    workers: config.workers,
    executor: config.executor,
    dependencies: [],
    // eslint-disable-next-line camelcase
    npm_dependencies: [],
  };

  if (config.dependencies) {
    parsedConfig.dependencies = Object.entries(config.dependencies).map(
      (dep) => {
        return { name: dep[0], version: dep[1] };
      }
    );
  }

  if (config.npm_dependencies) {
    // eslint-disable-next-line camelcase
    parsedConfig.npm_dependencies = Object.entries(config.npm_dependencies).map(
      (dep) => {
        return { name: dep[0], version: dep[1] };
      }
    );
  }

  return parsedConfig;
}

/**
 * @param {string} filepath Name of the file containing the configurations for the clio host in format `foo.toml`.
 */
function getHostConfig(filepath) {
  const file = fs.readFileSync(filepath);
  const config = toml.parse(file);

  const parsedConfig = {
    servers: config.servers,
    workers: config.workers,
  };

  return parsedConfig;
}

/* Package editing */

/**
 * Write a configuration object into the package config
 *
 * @param {object} config
 */
function writePackageConfig(config, directory = process.cwd()) {
  const dependencies = {};
  const npm_dependencies = {};
  config.dependencies?.forEach((dep) => (dependencies[dep.name] = dep.version));
  config.npm_dependencies?.forEach(
    (dep) => (npm_dependencies[dep.name] = dep.version)
  );
  const cfgStr = toml.stringify({ ...config, dependencies, npm_dependencies });
  const filePath = path.join(directory, CONFIGFILE_NAME);
  fs.writeFileSync(filePath, cfgStr);
}

/**
 * Add a dependency to the package config
 *
 * @param {string[]} dep - [ name, version ]
 */
function addDependency(dependency) {
  const config = getPackageConfig();
  const [name, version] = dependency;

  config.dependencies = config.dependencies || [];
  config.dependencies.push({ name, version });

  writePackageConfig(config);

  console.log(
    `Added ${name}@${version} to the dependencies list in ${CONFIGFILE_NAME}`
  );
}

/**
 * Add a npm dependency to the package config
 *
 * @param {string[]} dep - [ name, version ]
 */
function addNpmDependency(dependency) {
  const config = getPackageConfig();
  const [name, version] = dependency;

  config.npm_dependencies = config.npm_dependencies || [];
  config.npm_dependencies.push({ name, version });

  writePackageConfig(config);

  console.log(
    `Added ${name}@${version} to the dependencies list in ${CONFIGFILE_NAME}`
  );
}

/**
 * @param {Object} config Override config to write.
 */
function writeHostConfig(destination, config, relativeMain) {
  const configName = new Date().toISOString().replace(/:/g, "-");
  const base = path.join(destination, ".clio", ".host", configName);
  if (!fs.existsSync(base)) fs.mkdirSync(base, { recursive: true });
  fs.writeFileSync(
    path.join(base, "rpc.json"),
    JSON.stringify(config, null, 2)
  );
  fs.writeFileSync(
    path.join(base, "host.js"),
    [
      `const runner = require("clio-run/src/runners/auto.js");`,
      `const config = require("./rpc.json");`,
      `runner(require.resolve("../../../${relativeMain}.js"), config, true);`,
    ].join("\n")
  );
  return configName;
}

module.exports = {
  CONFIGFILE_NAME,
  addDependency,
  addNpmDependency,
  getPackageConfig,
  writePackageConfig,
  getHostConfig,
  writeHostConfig,
};

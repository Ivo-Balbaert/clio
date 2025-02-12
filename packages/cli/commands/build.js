const fs = require("fs");
const path = require("path");
const { compile } = require("clio-core");
const { error, info, warn } = require("../lib/colors");
const { getPlatform } = require("../lib/platforms");
const { Progress } = require("../lib/progress");

const {
  CONFIGFILE_NAME,
  ENV_NAME,
  fetchNpmDependencies,
  getPackageConfig,
  hasInstalledNpmDependencies,
  getParsedNpmDependencies,
  makeStartScript,
} = require("clio-manifest");

const asyncCompile = async (...args) => compile(...args);

const flatten = (arr) => arr.reduce((acc, val) => acc.concat(val), []);

const isDir = (dir) => fs.lstatSync(dir).isDirectory();
const readDir = (dir) => fs.readdirSync(dir);
const walkDir = (dir) => readDir(dir).map((f) => walk(path.join(dir, f)));
const walk = (dir) => (isDir(dir) ? flatten(walkDir(dir)) : [dir]);

const isClioFile = (file) => file.endsWith(".clio");
const isNotClioFile = (file) => !isClioFile(file);
const getClioFiles = (dir) => walk(dir).filter(isClioFile);
const getNonClioFiles = (dir) => walk(dir).filter(isNotClioFile);

const copyDir = async (src, dest) => {
  const entries = await fs.promises.readdir(src, { withFileTypes: true });
  mkdir(dest);
  for (let entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isSymbolicLink()) {
      const target = fs.readlinkSync(srcPath);
      const absTarget = path.isAbsolute(target)
        ? target
        : path.resolve(path.dirname(srcPath), target);
      fs.symlinkSync(absTarget, destPath);
    } else if (entry.isDirectory()) {
      await copyDir(srcPath, destPath);
    } else {
      await fs.promises.copyFile(
        srcPath,
        destPath,
        fs.constants.COPYFILE_FICLONE
      );
    }
  }
};

const rmdir = (directory) => {
  if (fs.existsSync(directory)) fs.rmSync(directory, { recursive: true });
};

const mkdir = (directory) => {
  if (!fs.existsSync(directory)) fs.mkdirSync(directory, { recursive: true });
};

function getDestinationFromConfig(source, target, config) {
  if (!config) {
    throw new Error('You must pass the location of the "clio.toml" file.');
  }

  const buildConfig = config.build;
  const buildDirectory = buildConfig.directory;

  if (!buildDirectory) {
    throw new Error(
      `The build directory is missing on your "${CONFIGFILE_NAME}".\n\nExample:\n\n[build]\ndirectory = "build"\n`
    );
  }

  return path.join(source, buildDirectory, target);
}

// FIXME I'm not sure if this function should stay here
function getBuildTarget(targetOverride, config) {
  if (!config) {
    throw new Error('You must pass the location of the "clio.toml" file.');
  }
  const buildConfig = config.build;

  if (!buildConfig) {
    throw new Error(
      `No build configuration has been found. Please add a [build] section to your "${CONFIGFILE_NAME}" file.`
    );
  }

  const buildTarget =
    targetOverride ||
    (buildConfig.target in config.target
      ? config.target[buildConfig.target].target
      : buildConfig.target);

  if (!buildTarget) {
    throw new Error(
      `"target" field is missing in your ${CONFIGFILE_NAME} file. You can override the target with the "--target" option.`
    );
  }

  return buildTarget;
}

function getSourceFromConfig(source, target, config) {
  const buildConfig = config.build;

  if (!buildConfig) {
    throw new Error(
      `No build configuration has been found. It is a "[build]" section on your "${CONFIGFILE_NAME}" file.`
    );
  }

  const buildSource =
    buildConfig.target in config.target
      ? config.target[buildConfig.target].directory
      : buildConfig.source;

  if (!buildSource) {
    throw new Error(
      `Could not find a source directory for ${target} in your ${CONFIGFILE_NAME} file.`
    );
  }

  return path.join(source, buildSource);
}

/**
 *
 * @param {string} source The project source directory
 * @param {string} dest Destination directory to build.
 * @param {Object} options Options to build
 */
const build = async (
  source,
  dest,
  { targetOverride, skipBundle, skipNpmInstall, silent } = {}
) => {
  const config = getPackageConfig(path.join(source, CONFIGFILE_NAME));
  const target = getBuildTarget(targetOverride, config);
  const destination = dest || getDestinationFromConfig(source, target, config);
  const sourceDir = getSourceFromConfig(source, target, config);
  const relativeMain = config.main.slice(target.length);

  if (!silent) info(`Creating build for ${target}`);

  const progress = new Progress(silent);
  try {
    progress.start("Compiling source...");

    // Build source
    const files = getClioFiles(sourceDir);
    for (const file of files) {
      const relativeFile = path.relative(sourceDir, file);
      const destFileClio = path.join(destination, relativeFile);
      const destFile = `${destFileClio}.js`;
      const destDir = path.dirname(destFile);
      const contents = fs.readFileSync(file, "utf8");
      const { code, map } = await asyncCompile(contents, relativeFile).catch(
        (compileError) => {
          console.error(compileError.message);
          process.exit(1);
        }
      );
      mkdir(destDir);
      await fs.promises.writeFile(destFileClio, contents, "utf8");
      await fs.promises.writeFile(destFile, code, "utf8");
      await fs.promises.writeFile(`${destFile}.map`, map, "utf8");
    }

    mkdir(path.join(destination, ".clio"));
    progress.succeed();

    // Add index.js file
    progress.start("Adding Clio start script...");
    makeStartScript(config, target, destination, relativeMain);
    progress.succeed();

    // Init npm modules
    try {
      const packageJsonPath = path.join(destination, "package.json");
      const dependencies = getParsedNpmDependencies(source);
      dependencies["clio-run"] = "latest";
      const packageJsonContent = {
        dependencies,
        main: `${config.main}.js`,
      };
      fs.writeFileSync(
        packageJsonPath,
        JSON.stringify(packageJsonContent, null, 2),
        { flag: "w" }
      );

      if (!skipNpmInstall) {
        progress.start(
          "Installing npm dependencies (this may take a while)..."
        );
        await fetchNpmDependencies(destination, silent);
        progress.succeed();
      }
    } catch (e) {
      progress.fail(`Error: ${e.message}`);
      error(e, "Dependency Install");
      // process.exit(4);
    }

    // Build clio deps
    if (fs.existsSync(path.join(source, ENV_NAME))) {
      progress.start("Compiling Clio dependencies...");
      const files = getClioFiles(path.join(source, ENV_NAME));
      for (const file of files) {
        const relativeFile = path.relative(source, file);
        const destFileClio = path
          .join(destination, relativeFile)
          .replace(ENV_NAME, "node_modules");
        const destFile = `${destFileClio}.js`;
        const contents = await fs.promises.readFile(file, "utf8");
        const { code, map } = await asyncCompile(contents, relativeFile).catch(
          (compileError) => {
            console.error(compileError.message);
            process.exit(1);
          }
        );
        const destDir = path.dirname(destFile);
        mkdir(destDir);
        await fs.promises.writeFile(destFileClio, contents, "utf8");
        await fs.promises.writeFile(destFile, code, "utf8");
        await fs.promises.writeFile(`${destFile}.map`, map, "utf8");
      }
      progress.succeed();

      // Build package.json files
      progress.start("Linking Clio dependencies...");
      const clioDepDirs = fs.readdirSync(path.join(source, ENV_NAME));
      for (const depDir of clioDepDirs) {
        buildPackageJson(source, depDir, destination);
      }
      progress.succeed();
    }
  } catch (e) {
    progress.fail(`Error: ${e}`);
    error(e, "Compilation");
    // process.exit(3);
  }

  const nonClioFiles = getNonClioFiles(sourceDir);
  for (const file of nonClioFiles) {
    const relativeFile = path.relative(sourceDir, file);
    const destFile = path.join(destination, relativeFile);
    const destDir = path.dirname(destFile);
    mkdir(destDir);
    await fs.promises.copyFile(file, destFile);
  }

  if (!skipNpmInstall && !hasInstalledNpmDependencies(destination)) {
    progress.start("Installing npm dependencies (this may take a while)...");
    await fetchNpmDependencies(destination, silent);
    progress.succeed();
  }

  if (process.env.CLIOPATH) {
    // Link local internals
    warn("Using local internals. This should only be used for debug purposes.");
    warn(
      "If you encounter any unwanted behavior, unset the CLIOPATH environment variable"
    );
    progress.succeed();
    progress.start("Linking dependencies");
    rmdir(path.join(destination, "node_modules", "clio-run"));
    await link(
      path.resolve(process.env.CLIOPATH, "packages", "run"),
      path.join(destination, "node_modules", "clio-run")
    );
    rmdir(path.join(destination, "node_modules", "clio-rpc"));
    await link(
      path.resolve(process.env.CLIOPATH, "packages", "rpc"),
      path.join(destination, "node_modules", "clio-rpc")
    );
    progress.succeed();
  }

  try {
    const platform = getPlatform(target);
    await platform.build(destination, skipBundle);
  } catch (e) {
    error(e, "Bundling");
  }
};

/**
 * Link local internals package as a dependency
 * @param {string} destination Full path to destination directory
 */
async function link(source, destination) {
  await copyDir(source, destination);
}

/**
 * Generates a package.json for a clio module.
 * Reads the configuration file of the module and builds a package.json file containing all nessessary fields
 *
 * @param {string} source source root directory of clio project
 * @param {string} dependency name of the dependency being compiled
 * @param {string} destination destination for package.json
 */
const buildPackageJson = (source, dependency, destination) => {
  const configPath = path.join(source, ENV_NAME, dependency, CONFIGFILE_NAME);
  const config = getPackageConfig(configPath);
  const packageJson = {
    main: config.main,
    title: config.title,
    clio: { config },
  };
  const destFilePath = path.join(
    destination,
    "node_modules",
    path.basename(dependency),
    "package.json"
  );
  fs.writeFileSync(destFilePath, JSON.stringify(packageJson));
};

const command = "build [target] [source] [destination]";
const desc = "Build a Clio project";

const handler = (argv) => {
  const options = {
    targetOverride: argv.target,
    skipBundle: argv["skip-bundle"],
    skipNpmInstall: argv["skip-npm-install"],
  };
  build(argv.source, argv.destination, options);
};
const builder = {
  source: {
    describe: "source directory to read from",
    type: "string",
    default: path.resolve("."),
  },
  destination: {
    describe: "destination directory to write to",
    type: "string",
  },
  target: {
    describe: "An override for the default project target.",
    type: "string",
  },
  "skip-bundle": {
    describe: "Does not produces a bundle for browsers.",
    type: "boolean",
  },
  "skip-npm-install": {
    describe: "Skips npm install. Useful for tests.",
    type: "boolean",
  },
  silent: {
    describe: "Mutes messages from the command.",
    type: "boolean",
  },
};

module.exports = {
  build,
  command,
  desc,
  builder,
  handler,
  getBuildTarget,
  getDestinationFromConfig,
  copyDir,
};

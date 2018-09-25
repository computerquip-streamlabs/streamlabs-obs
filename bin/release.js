/*
 * All-in-one interactive Streamlabs OBS release script.
 */

const sh = require('shelljs');
const inq = require('inquirer');
const semver = require('semver');
const colors = require('colors/safe');
const fs = require('fs');
const path = require('path');
const AWS = require('aws-sdk');
const ProgressBar = require('progress');
const yml = require('js-yaml');
const cp = require('child_process');

/**
 * CONFIGURATION
 */
const s3Bucket = 'streamlabs-obs-dev';
const sentryOrg = 'streamlabs-obs';
const sentryProject = 'streamlabs-obs-dev';


function info(msg) {
  sh.echo(colors.magenta(msg));
}

function error(msg) {
  sh.echo(colors.red(`ERROR: ${msg}`));
}

function executeCmd(cmd) {
  const result = sh.exec(cmd);

  if (result.code !== 0) {
    error(`Command Failed >>> ${cmd}`);
    sh.exit(1);
  }
}

function sentryCli(cmd) {
  // const sentryPath = path.join('bin', 'node_modules', 'sentry-cli-binary', 'bin', 'sentry-cli');

  // executeCmd(`${sentryPath} releases --org "${sentryOrg}" --project "${sentryProject}" ${cmd}`);
}

async function confirm(msg) {
  const result = await inq.prompt({
    type: 'confirm',
    name: 'conf',
    message: msg
  });

  return result.conf;
}

function checkEnv(varName) {
  if (!process.env[varName]) {
    error(`Missing environment variable ${varName}`);
    sh.exit(1);
  }
}

/* We can change the release script to export a function instead.
 * I already made this into a separate script so I think this is fine */
async function uploadUpdateFiles(s3_key, s3_skey, new_version, app_dir) {
  return new Promise((resolve, reject) => {
    const submodule = cp.fork(
      'bin/release-uploader.js',
      [
        '--access-key', s3_key,
        '--secret-access-key', s3_skey,
        '--version', new_version,
        '--release-dir', app_dir
      ]
    );

    submodule.on('close', (code) => {
      if (code !== 0) {
        reject(code);
      } else {
        resolve();
      }
    });
  });
}

async function setLatestVersion(s3_key, s3_skey, new_version) {
  return new Promise((resolve, reject) => {
    const submodule = cp.fork(
      'bin/set-latest.js',
      [
        '--access-key', s3_key,
        '--secret-access-key', s3_skey,
        '--version', new_version
      ]
    );

    submodule.on('close', (code) => {
      if (code !== 0) {
        reject(code);
      } else {
        resolve();
      }
    });
  });
}

async function setChance(s3_key, s3_skey, new_version, chance) {
  return new Promise((resolve, reject) => {
    const submodule = cp.fork(
      'bin/set-chance.js',
      [
        '--access-key', s3_key,
        '--secret-access-key', s3_skey,
        '--version', new_version,
        '--chance', chance
      ]
    );

    submodule.on('close', (code) => {
      if (code !== 0) {
        reject(code);
      } else {
        resolve();
      }
    });
  });
}

async function uploadS3File(name, filePath) {
  info(`Starting upload of ${name}...`);

  const stream = fs.createReadStream(filePath);
  const upload = new AWS.S3.ManagedUpload({
    params: {
      Bucket: s3Bucket,
      Key: name,
      ACL: 'public-read',
      Body: stream
    },
    queueSize: 1
  });

  const bar = new ProgressBar(`${name} [:bar] :percent :etas`, {
    total: 100,
    clear: true
  });

  upload.on('httpUploadProgress', progress => {
    bar.update(progress.loaded / progress.total);
  });

  try {
    await upload.promise();
  } catch (err) {
    error(`Upload of ${name} failed`);
    sh.echo(err);
    sh.exit(1);
  }
}

/**
 * This is the main function of the script
 */
async function runScript() {
  info(colors.magenta('|-------------------------------------------|'));
  info(colors.magenta('| Streamlabs OBS Interactive Release Script |'));
  info(colors.magenta('|-------------------------------------------|'));

  if (!await confirm('Are you sure you want to release?')) sh.exit(0);

  // Start by figuring out if this environment is configured properly
  // for releasing.
  checkEnv('AWS_ACCESS_KEY_ID');
  checkEnv('AWS_SECRET_ACCESS_KEY');
  checkEnv('SENTRY_AUTH_TOKEN');

  /* Technically speaking, we allow any number of
   * channels. Maybe in the future, we allow custom
   * options here? */
  const isPreview = (await inq.prompt({
    type: 'list',
    name: 'releaseType',
    message: 'Which type of release would you like to do?',
    choices: [
      {
        name: 'Normal release (All users will receive this release)',
        value: 'normal'
      },
      {
        name: 'Preview release',
        value: 'preview'
      }
    ]
  })).releaseType === 'preview';

  let sourceBranch;
  let targetBranch;

  if (isPreview) {
    // Preview releases always happen from staging
    sourceBranch = 'staging';
    targetBranch = 'preview';
  } else {
    sourceBranch = (await inq.prompt({
      type: 'list',
      name: 'branch',
      message: 'Which branch would you like to release from?',
      choices: [
        {
          name: 'preview',
          value: 'preview'
        },
        {
          name: 'staging',
          value: 'staging'
        },
        {
          name: 'master (hotfix releases only)',
          value: 'master'
        }
      ]
    })).branch;
    targetBranch = 'master';
  }

  // Make sure the release environment is clean
  info('Stashing all uncommitted changes...');
  executeCmd('git add -A');
  executeCmd('git stash');

  // Sync the source branch
  info(`Syncing ${sourceBranch} with the origin...`);
  executeCmd('git fetch');
  executeCmd(`git checkout ${sourceBranch}`);
  executeCmd('git pull');
  executeCmd(`git reset --hard origin/${sourceBranch}`);

  if (sourceBranch !== targetBranch) {
    // Sync the target branch
    info(`Syncing ${targetBranch} with the origin...`);
    executeCmd('git fetch');
    executeCmd(`git checkout ${targetBranch}`);
    executeCmd('git pull');
    executeCmd(`git reset --hard origin/${targetBranch}`);

    // Merge the source branch into the target branch
    info(`Merging ${sourceBranch} into ${targetBranch}...`);
    executeCmd(`git merge ${sourceBranch}`);
  }

  info('Removing old packages...');
  sh.rm('-rf', 'node_modules');

  info('Installing fresh packages...');
  executeCmd('yarn install');

  info('Installing OBS plugins...');
  executeCmd('yarn install-plugins');

  info('Compiling assets...');
  executeCmd('yarn compile:production');

  const pjson = JSON.parse(fs.readFileSync('package.json'));
  const currentVersion = pjson.version;

  info(`The current application version is ${currentVersion}`);

  let versionOptions;

  if (isPreview) {
    versionOptions = [
      semver.inc(currentVersion, 'prerelease', 'preview'),
      semver.inc(currentVersion, 'prepatch', 'preview'),
      semver.inc(currentVersion, 'preminor', 'preview'),
      semver.inc(currentVersion, 'premajor', 'preview')
    ];
  } else {
    versionOptions = [
      semver.inc(currentVersion, 'patch'),
      semver.inc(currentVersion, 'minor'),
      semver.inc(currentVersion, 'major')
    ];
  }

  // Remove duplicates
  versionOptions = [...new Set(versionOptions)];

  const newVersion = (await inq.prompt({
    type: 'list',
    name: 'newVersion',
    message: 'What should the new version number be?',
    choices: versionOptions
  })).newVersion;

  if (!await confirm(`Are you sure you want to package version ${newVersion}?`)) sh.exit(0);

  pjson.version = newVersion;

  info(`Writing ${newVersion} to package.json...`);
  fs.writeFileSync('package.json', JSON.stringify(pjson, null, 2));

  info('Packaging the app...');
  executeCmd(`yarn package${isPreview ? ':preview' : ''}`);

  info(`Version ${newVersion} is ready to be deployed.`);
  info('You can find the packaged app at dist/win-unpacked.');
  info('Please run the packaged application now to ensure it starts up properly.');
  info('When you have confirmed the packaged app works properly, you');
  info('can continue with the deploy.');

  if (!await confirm('Are you ready to deploy?')) sh.exit(0);

  const chance = (await inq.prompt({
    type: input,
    name: 'chance'
    message: 'Chance for update to occur'
  })).chance;

  info('Committing changes...');
  executeCmd('git add -A');
  executeCmd(`git commit -m "Release version ${newVersion}"`);

  info('Pushing changes...');
  executeCmd('git push origin HEAD');

  info(`Tagging version ${newVersion}...`);
  executeCmd(`git tag -f v${newVersion}`);
  executeCmd('git push --tags');

  info(`Registering ${newVersion} with sentry...`);
  sentryCli(`new "${newVersion}"`);
  sentryCli(`set-commits --auto "${newVersion}"`);

  info('Uploading compiled source to sentry...');
  const sourcePath = path.join('bundles', 'renderer.js');
  const sourceMapPath = path.join('bundles', 'renderer.js.map');
  sentryCli(`files "${newVersion}" delete --all`);
  sentryCli(`files "${newVersion}" upload "${sourcePath}"`);
  sentryCli(`files "${newVersion}" upload "${sourceMapPath}"`);

  info('Discovering publishing artifacts...');
  const distDir = path.resolve('.', 'dist');
  const channelFileName = path.parse(sh.ls(path.join(distDir, '*.yml'))[0]).base;
  const channelFilePath = path.join(distDir, channelFileName);

  info(`Discovered ${channelFileName}`);

  const parsedChannel = yml.safeLoad(fs.readFileSync(channelFilePath));
  const installerFileName = parsedChannel.path;
  const installerFilePath = path.join(distDir, installerFileName);

  if (!fs.existsSync(installerFilePath)) {
    error(`Could not find ${path.resolve(installerFilePath)}`);
    sh.exit(1);
  }

  info(`Disovered ${installerFileName}`);

  info('Uploading publishing artifacts...');
    /* Use the separate release-uploader script to upload our
   * win-unpacked content. */
  await uploadUpdateFiles(
    process.env['AWS_ACCESS_KEY_ID'],
    process.env['AWS_SECRET_ACCESS_KEY'],
    newVersion,
    path.resolve('dist', 'win-unpacked')
  );

  await uploadS3File(installerFileName, installerFilePath);
  await uploadS3File(channelFileName, channelFilePath);

  info('Finalizing release with sentry...');
  sentryCli(`finalize "${newVersion}`);

  info(`Merging ${targetBranch} back into staging...`);
  executeCmd(`git checkout staging`);
  executeCmd(`git merge ${targetBranch}`);
  executeCmd('git push origin HEAD');

  info(`Setting latest version...`);

  await setLatestVersion(
    process.env['AWS_ACCESS_KEY_ID'],
    process.env['AWS_SECRET_ACCESS_KEY'],
    newVersion
  );

  await setChance(
    process.env['AWS_ACCESS_KEY_ID'],
    process.env['AWS_SECRET_ACCESS_KEY'],
    newVersion,
    chance
  );

  info(`Version ${newVersion} released successfully!`);
}

runScript().then(() => {
  sh.exit(0);
});

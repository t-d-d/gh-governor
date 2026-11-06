/**
 * Turning a config file's features on and off in a test, in the layout of
 * `.github/governor.json`: a feature is on where the file has its section
 * and the section's `enabled` is not `false`, and `deployedLabels` is
 * `deployMessages.deployedLabels`.
 */

type File = Record<string, any>;

/**
 * The file with each named switch set: `true` keeps or adds its section and
 * drops any `"enabled": false`, `false` keeps the section with `"enabled":
 * false`, and `undefined` removes the section. The file is changed in place
 * and returned.
 */
export const switched = (file: File, switches: Record<string, boolean | undefined>): File => {
  for (const [name, on] of Object.entries(switches)) {
    if (name === 'deployedLabels') {
      file.deployMessages ??= { enabled: false };
      if (on === undefined) delete file.deployMessages.deployedLabels;
      else file.deployMessages.deployedLabels = on;
      continue;
    }
    if (on === undefined) {
      delete file[name];
    } else if (on) {
      file[name] ??= {};
      delete file[name].enabled;
    } else {
      file[name] = { ...(file[name] ?? {}), enabled: false };
    }
  }
  return file;
};

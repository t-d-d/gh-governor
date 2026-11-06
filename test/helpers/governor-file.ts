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
 * false`, and `undefined` removes the section. `deployedLabels` sets the key
 * in `deployMessages`, and `true` also turns `deployMessages` on. The file is
 * changed in place and returned.
 */
export const switched = (file: File, switches: Record<string, boolean | undefined>): File => {
  for (const [name, on] of Object.entries(switches)) {
    if (name === 'deployedLabels') {
      // The labels are a deploy message's work, so turning them on turns
      // deployMessages on too; off or unset leaves deployMessages as it is.
      file.deployMessages ??= { enabled: false };
      if (on === true) delete file.deployMessages.enabled;
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

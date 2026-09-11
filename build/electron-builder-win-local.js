// Unsigned local Windows package for this community fork.
// Does not publish, notarize, or use official Frame signing secrets.
// npmRebuild is off so electron-builder will not invoke VS Build Tools
// (install-app-deps exit 5008). Package the already-present native .node files.

const baseConfig = require('./electron-builder-base.js')

const config = {
  ...baseConfig,
  npmRebuild: false,
  forceCodeSigning: false,
  win: {
    signAndEditExecutable: false,
    icon: 'build/icons/icon.png',
    target: [
      {
        target: 'nsis',
        arch: ['x64']
      }
    ]
  },
  nsis: {
    oneClick: false,
    perMachine: false,
    allowToChangeInstallationDirectory: true,
    shortcutName: 'Frame Fork',
    uninstallDisplayName: 'Frame Fork',
    artifactName: 'Frame-Fork-Setup-${version}.${ext}'
  }
}

delete config.afterSign

module.exports = config

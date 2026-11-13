// Adjusts the Android project that Capacitor generates so that it suits Notereader.
// Run by `npm run android:prepare` after `cap add android`.
const fs = require('fs');

// 1. Permissions: camera for "Take photo"; plain-http so web links to http:// sites work.
const manifestFile = 'android/app/src/main/AndroidManifest.xml';
let manifest = fs.readFileSync(manifestFile, 'utf8');
if (!manifest.includes('android.permission.CAMERA')) {
  manifest = manifest.replace('</manifest>', '    <uses-permission android:name="android.permission.CAMERA" />\n</manifest>');
}
if (!manifest.includes('usesCleartextTraffic')) {
  manifest = manifest.replace('<application', '<application\n        android:usesCleartextTraffic="true"\n        android:largeHeap="true"');
}
fs.writeFileSync(manifestFile, manifest);

// 2. Let the reading engine use several processor cores. Browsers only allow that
//    on "cross-origin isolated" pages, which needs two response headers on the
//    app's own files. Capacitor's local file server has no setting for extra
//    headers, so they are added to its source (inside node_modules) at build time.
//    Where the device's WebView does not support this, the engine uses one core.
const serverFile = 'node_modules/@capacitor/android/capacitor/src/main/java/com/getcapacitor/WebViewLocalServer.java';
let server = fs.readFileSync(serverFile, 'utf8');
const anchor = 'tempResponseHeaders.put("Cache-Control", "no-cache");';
if (!server.includes('Cross-Origin-Embedder-Policy')) {
  if (!server.includes(anchor)) throw new Error(`Capacitor changed: "${anchor}" not found in ${serverFile}`);
  server = server.replace(anchor, `${anchor}
            tempResponseHeaders.put("Cross-Origin-Opener-Policy", "same-origin"); // notereader
            tempResponseHeaders.put("Cross-Origin-Embedder-Policy", "require-corp"); // notereader`);
  fs.writeFileSync(serverFile, server);
}

// 3. Version, signing and packaging.
//    Every build must be signed with the same key, otherwise Android refuses to
//    install a new version over the old one. The key lives in android-signing/.
const build = Number(process.env.BUILD_NUMBER || 0);
const version = `1.${build}`;
const gradleFile = 'android/app/build.gradle';
let gradle = fs.readFileSync(gradleFile, 'utf8');
if (!gradle.includes('// notereader')) {
  gradle += `
// notereader
android {
    defaultConfig {
        versionCode ${Math.max(build, 1)}
        versionName "${version}"
    }
    signingConfigs {
        debug {
            storeFile file('../../android-signing/notereader.keystore')
            storePassword 'android'
            keyAlias 'androiddebugkey'
            keyPassword 'android'
        }
    }
    // The recognition models are already compressed; storing them as-is makes them faster to load.
    androidResources {
        noCompress += ['onnx', 'wasm', 'whl', 'zip']
    }
}
`;
  fs.writeFileSync(gradleFile, gradle);
}

// 4. Tell the app which version it is and where to look for newer ones.
if (build > 0) {
  // Public repository whose releases the app checks for updates.
  const repo = process.env.UPDATE_REPO || process.env.GITHUB_REPOSITORY || '';
  fs.writeFileSync('web/version.json', JSON.stringify({ version, build, repo }) + '\n');
  console.log(`version.json: ${version} (${repo})`);
} else {
  fs.rmSync('web/version.json', { force: true });
}
console.log('Android project adjusted');

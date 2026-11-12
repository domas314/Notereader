// Adds what the generated Android project needs for Notereader:
// camera access (for "Take photo") and plain-http access to a server on the home network.
const fs = require('fs');
const file = 'android/app/src/main/AndroidManifest.xml';
let xml = fs.readFileSync(file, 'utf8');
if (!xml.includes('android.permission.CAMERA')) {
  xml = xml.replace('</manifest>', '    <uses-permission android:name="android.permission.CAMERA" />\n</manifest>');
}
if (!xml.includes('usesCleartextTraffic')) {
  xml = xml.replace('<application', '<application\n        android:usesCleartextTraffic="true"');
}
fs.writeFileSync(file, xml);
console.log('AndroidManifest.xml updated');

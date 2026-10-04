# AegisFit Android Health Connect companion

This is the native Android bridge for the AegisFit web app. Browsers cannot directly read Android Health Connect, so this companion app requests Health Connect permissions, reads real device data, and sends it to the AegisFit server using a short-lived pairing code.

## Use
1. Open AegisFit on your PC and sign in.
2. Go to **Devices → Android Health Connect → Generate Pairing Code**.
3. Open this Android project in Android Studio and run it on your phone.
4. Make sure the phone and PC are on the same Wi-Fi network.
5. In the Android app, enter the PC's LAN address, e.g. `http://192.168.1.5:3000`.
6. Enter the 6-digit pairing code from AegisFit.
7. Tap **Allow Health Connect & Sync** and grant Steps, Heart Rate, and Active Calories permissions.
8. Return to AegisFit Devices; real synced values will appear.

Android 14+ includes Health Connect. Android 13 and lower require the Health Connect app to be installed. Health Connect access is permission-controlled by Android.

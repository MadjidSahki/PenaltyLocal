// Public Firebase web config: these values identify the project and are meant
// to be in the page. Access is controlled by database.rules.json.
const LOCAL_HOSTS = ["localhost", "127.0.0.1"];

export const emulators = LOCAL_HOSTS.includes(location.hostname)
  ? { host: "127.0.0.1", authPort: 9099, databasePort: 9400 }
  : null;

// reCAPTCHA Enterprise site key used by App Check (public, domain-restricted).
export const recaptchaSiteKey = "6LdAVQ0uAAAAAHbhc5a2hid_tk44G465gqK4jk9c";

export const firebaseConfig = emulators
  ? {
      apiKey: "demo-key",
      authDomain: "demo-penalty.firebaseapp.com",
      projectId: "demo-penalty",
      databaseURL: "http://127.0.0.1:9400/?ns=demo-penalty-default-rtdb",
    }
  : {
      apiKey: "AIzaSyBJAyfMyYO1n2apyD16NYEC873enC5r3Hk",
      authDomain: "penaltyleague.firebaseapp.com",
      projectId: "penaltyleague",
      databaseURL: "https://penaltyleague-default-rtdb.europe-west1.firebasedatabase.app",
      appId: "1:103672000508:web:7078e3ee5014e37c7ccc79",
      messagingSenderId: "103672000508",
    };

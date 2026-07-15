import { getAdminApp } from "../config/firebaseAdmin.js";

function parseArgs(argv) {
  const args = { email: "", role: "", driverId: "" };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--email") args.email = argv[i + 1] || "";
    if (argv[i] === "--role") args.role = argv[i + 1] || "";
    if (argv[i] === "--driver-id") args.driverId = argv[i + 1] || "";
  }
  return args;
}

function usage() {
  console.error(
    "Usage: node src/scripts/setUserClaims.js --email <user@example.com> --role owner|driver [--driver-id H-001]"
  );
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.email || !args.role) {
    usage();
    process.exit(1);
  }
  if (args.role !== "owner" && args.role !== "driver") {
    console.error("--role must be 'owner' or 'driver'.");
    process.exit(1);
  }
  if (args.role === "driver" && !args.driverId) {
    console.error("--driver-id is required for driver role (must match drivers/{id}).");
    process.exit(1);
  }

  const auth = getAdminApp().auth();
  const user = await auth.getUserByEmail(args.email);
  const claims = args.role === "owner"
    ? { role: "owner" }
    : { role: "driver", driverId: args.driverId };

  await auth.setCustomUserClaims(user.uid, claims);
  console.log(`Claims set for ${args.email} (uid ${user.uid}):`, claims);
  console.log("The user must sign out and sign back in for the new claims to take effect.");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

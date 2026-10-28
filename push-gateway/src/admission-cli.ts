import {readFileSync,writeFileSync} from 'node:fs';
import {mintInvitation} from './admission.js';

// An operator runs this locally; arguments contain paths, never the master key.
const args=process.argv.slice(2);
if(args.length!==4||args[0]!=='--key-file'||args[2]!=='--output'){
 console.error('Usage: node admission-cli.js --key-file /private/operator-key --output /private/new-invitation');
 process.exit(2);
}
const ticket=mintInvitation(readFileSync(args[1]!,'utf8').trim());
writeFileSync(args[3]!,ticket+'\n',{mode:0o600,flag:'wx'});
console.log('Invitation written; expires in 15 minutes. Deliver privately to one installation.');

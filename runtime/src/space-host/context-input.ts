import {spaceSourceInputSchema,type SpaceSourceScope} from '../memory-substrate/space-source-input.js';
import type {PersonalMemoryResource} from '../memory/personal-memory.js';
/** The sender comes from authenticated transport, never from a client-supplied field. */
export async function applySpaceSourceInput(memory:PersonalMemoryResource,scope:SpaceSourceScope,input:unknown):Promise<unknown>{
 const result=spaceSourceInputSchema.safeParse(input);
 if(!result.success)throw Error('invalid_source_input');
 const parsed=result.data;
 if(!memory.receiveSpaceSourceInput)throw Error('source_backend_unavailable');
 return memory.receiveSpaceSourceInput(scope,parsed);
}

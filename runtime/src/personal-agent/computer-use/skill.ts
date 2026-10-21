/** Appended to Build instructions only while Computer Use is on for the conversation. */
export function computerUseSkill(direct:boolean):string{
 return [
  'Computer Use is enabled for this Build. The user can see an on-screen indicator and can Stop at any time.',
  direct
   ? 'Take computer_screenshot before each click/scroll and before finish; coordinates refer to the latest screenshot. After clicking a field, computer_type and computer_key may follow directly.'
   : 'This model cannot see images; use computer_run for interface work and inspect its returned result.',
  'Use computer_run to hand a whole interface task to the computer agent; it returns after the task ends.',
  'After changing code that affects an interface, start the app with shell_execute, operate it, and fix what you observe; repeat until it works.',
  'If an earlier input is unknown, stopped or resumed, take a fresh screenshot and confirm the state before acting again. Never repeat a completed input blindly.',
  'Before finish_build, confirm the result on a fresh screenshot. Do not report interface work as done because it was only handed off.',
 ].join('\n')
}

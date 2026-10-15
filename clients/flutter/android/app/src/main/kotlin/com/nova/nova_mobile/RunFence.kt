package com.nova.nova_mobile

data class RunToken(val taskId: String, val revision: Long, val epoch: String)

/** Every model return and UI action crosses the same native stop/budget fence. */
class RunFence(private val taskId: String, private val deadline: Long, private val maxSteps: Int) {
    private val epoch=java.util.UUID.randomUUID().toString()
    private var revision=0L
    private var stopped=false
    private var steps=0
    @Synchronized fun token()=RunToken(taskId,revision,epoch)
    @Synchronized fun allows(token: RunToken, now: Long)=!stopped && token.taskId==taskId && token.revision==revision && token.epoch==epoch && now<deadline && steps<maxSteps
    @Synchronized fun claim(token: RunToken, now: Long): Boolean {
        if(!allows(token,now))return false
        steps++
        return true
    }
    @Synchronized fun allowsAfterClaim(token: RunToken,now: Long)=!stopped&&token.taskId==taskId&&token.revision==revision&&token.epoch==epoch&&now<deadline
    @Synchronized fun stop(){stopped=true;revision++}
}

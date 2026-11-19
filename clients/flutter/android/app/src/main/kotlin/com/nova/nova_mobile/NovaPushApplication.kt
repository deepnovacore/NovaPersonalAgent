package com.nova.nova_mobile

class NovaPushApplication : android.app.Application() {
    internal val runtime by lazy { NovaRuntime(this) }
    override fun onCreate() { super.onCreate(); NovaSpacePush.initialize(this) }
}

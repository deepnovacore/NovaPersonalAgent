package com.nova.nova_mobile

class NovaPushApplication : android.app.Application() {
    override fun onCreate() { super.onCreate(); NovaSpacePush.initialize(this) }
}

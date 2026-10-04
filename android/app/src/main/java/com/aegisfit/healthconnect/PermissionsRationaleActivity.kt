package com.aegisfit.healthconnect

import android.app.Activity
import android.os.Bundle
import android.widget.TextView

class PermissionsRationaleActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(TextView(this).apply {
            text = "AegisFit uses Health Connect to read steps, active calories, and heart-rate data for your fitness dashboard. You control which data AegisFit can access."
            textSize = 18f
            setPadding(40, 60, 40, 60)
        })
    }
}

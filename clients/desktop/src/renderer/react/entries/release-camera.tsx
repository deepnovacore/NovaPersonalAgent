import '@radix-ui/themes/styles.css'
import React from "react"
import {createRoot} from "react-dom/client"
import {DesktopTheme,ErrorBoundary} from "../theme"
import {ReleaseCameraApp} from "../auxiliary"
createRoot(document.getElementById("root")!).render(<DesktopTheme transparent={true}><ErrorBoundary><ReleaseCameraApp/></ErrorBoundary></DesktopTheme>)

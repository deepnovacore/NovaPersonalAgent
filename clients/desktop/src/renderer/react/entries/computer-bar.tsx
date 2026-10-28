import '@radix-ui/themes/styles.css'
import React from "react"
import {createRoot} from "react-dom/client"
import {DesktopTheme,ErrorBoundary} from "../theme"
import {ComputerBarApp} from "../auxiliary"
createRoot(document.getElementById("root")!).render(<DesktopTheme transparent={true}><ErrorBoundary><ComputerBarApp/></ErrorBoundary></DesktopTheme>)

import '@radix-ui/themes/styles.css'
import React from "react"
import {createRoot} from "react-dom/client"
import {DesktopTheme,ErrorBoundary} from "../theme"
import SetupApp from "../setup"
createRoot(document.getElementById("root")!).render(<DesktopTheme transparent={false}><ErrorBoundary><SetupApp/></ErrorBoundary></DesktopTheme>)

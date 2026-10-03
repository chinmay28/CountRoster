package io.github.chinmay28.countroster

import android.content.Context
import android.net.ConnectivityManager
import android.net.LinkProperties
import android.net.Network

/**
 * Follows the default network's DNS servers (a VPN's, when one is up — e.g.
 * Tailscale's 100.100.100.100, which is what makes a MagicDNS server name
 * resolve) and reports each change.
 *
 * The engine is a cgo-free Go binary, and Go's own resolver can't find
 * Android's DNS servers (there is no /etc/resolv.conf). Without this, sync to
 * anything but an IP address would fail.
 */
class DnsWatcher(context: Context, private val onChange: (List<String>) -> Unit) {
    private val connectivity = context.getSystemService(ConnectivityManager::class.java)

    fun start() {
        connectivity.activeNetwork?.let { network ->
            connectivity.getLinkProperties(network)?.let(::report)
        }
        connectivity.registerDefaultNetworkCallback(object : ConnectivityManager.NetworkCallback() {
            override fun onLinkPropertiesChanged(network: Network, lp: LinkProperties) = report(lp)
        })
    }

    private fun report(lp: LinkProperties) {
        val servers = lp.dnsServers.mapNotNull { it.hostAddress }
        if (servers.isNotEmpty()) onChange(servers)
    }
}

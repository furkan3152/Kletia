import React, { useEffect, useState } from 'react';
import { Shield, ShieldAlert, ShieldCheck } from 'lucide-react';
import { getAddress, isAddress } from 'viem';
import { NETWORKS } from '../config/networks';
import { BACKEND_URL } from '../config/runtime';

interface RiskData {
    address: string;
    riskScore: number;
    riskLevel: string;
    tags: string[];
    decision: 'approved' | 'blocked';
    source: 'webacy';
    network: 'base';
    chainId: number;
}

interface RiskBadgeProps {
    address: string;
}

export const RiskBadge: React.FC<RiskBadgeProps> = ({ address }) => {
    const [riskData, setRiskData] = useState<RiskData | null>(null);
    const [loading, setLoading] = useState(true);
    const [failed, setFailed] = useState(false);

    useEffect(() => {
        const fetchRisk = async () => {
            setRiskData(null);
            setFailed(false);
            if (!isAddress(address)) {
                setLoading(false);
                setFailed(true);
                return;
            }
            setLoading(true);
            const expectedAddress = getAddress(address);
            try {
                const res = await fetch(
                    `${BACKEND_URL}/api/webacy/address/${expectedAddress}?network=base&chainId=${NETWORKS.base.chainId}`,
                    {
                        headers: {
                            Accept: 'application/json',
                            'X-Kletia-Network': 'base',
                            'X-Kletia-Chain-Id': String(NETWORKS.base.chainId),
                        },
                    },
                );
                const data = await res.json().catch(() => null);
                if (
                    !res.ok ||
                    !data ||
                    data.status !== 'success' ||
                    data.network !== 'base' ||
                    data.chainId !== NETWORKS.base.chainId ||
                    data.source !== 'webacy' ||
                    (data.decision !== 'approved' && data.decision !== 'blocked') ||
                    typeof data.address !== 'string' ||
                    !isAddress(data.address) ||
                    getAddress(data.address) !== expectedAddress ||
                    typeof data.riskScore !== 'number' ||
                    !Number.isFinite(data.riskScore) ||
                    data.riskScore < 0 ||
                    data.riskScore > 100 ||
                    typeof data.riskLevel !== 'string' ||
                    !Array.isArray(data.tags) ||
                    !data.tags.every((tag: unknown) => typeof tag === 'string')
                ) {
                    throw new Error('Invalid Webacy Base response.');
                }
                setRiskData(data as RiskData);
            } catch {
                setFailed(true);
            } finally {
                setLoading(false);
            }
        };

        fetchRisk();
    }, [address]);

    if (loading) {
        return (
            <div className="flex items-center gap-2 px-3 py-1.5 bg-gray-800/50 rounded-full border border-gray-700 animate-pulse">
                <Shield className="w-4 h-4 text-gray-500" />
                <span className="text-xs text-gray-400">Security Check...</span>
            </div>
        );
    }

    if (!riskData || failed) {
        return (
            <div className="flex items-center gap-2 px-3 py-1.5 bg-red-500/10 border border-red-500/20 rounded-full">
                <ShieldAlert className="w-4 h-4 text-red-500" />
                <span className="text-xs font-medium text-red-500">
                    Security unavailable
                </span>
            </div>
        );
    }

    const { riskScore, riskLevel } = riskData;

    let bgColor = "bg-green-500/10";
    let textColor = "text-green-500";
    let borderColor = "border-green-500/20";
    let Icon = ShieldCheck;
    let label = "Provider Low Risk";

    if (riskData.decision === 'blocked') {
        bgColor = "bg-red-500/10";
        textColor = "text-red-500";
        borderColor = "border-red-500/20";
        Icon = ShieldAlert;
        label = "Provider Blocked";
    } else if (riskScore > 20) {
        bgColor = "bg-yellow-500/10";
        textColor = "text-yellow-500";
        borderColor = "border-yellow-500/20";
        Icon = Shield;
        label = "Orta Riskli";
    }

    return (
        <div 
            className={`flex items-center gap-2 px-3 py-1.5 ${bgColor} ${borderColor} border rounded-full backdrop-blur-sm transition-all hover:bg-opacity-20`}
            title={`Webacy DD.xyz Risk Score: ${riskScore.toFixed(2)}`}
        >
            <Icon className={`w-4 h-4 ${textColor}`} />
            <span className={`text-xs font-medium ${textColor}`}>
                {label} {riskLevel && `(${riskLevel})`}
            </span>
            {riskData.tags.length > 0 && (
                <div className="hidden md:flex gap-1 ml-2 pl-2 border-l border-gray-600/50">
                    {riskData.tags.slice(0, 2).map((tag, i) => (
                        <span key={i} className="text-[10px] px-1.5 py-0.5 bg-gray-800/80 text-gray-300 rounded">
                            {tag}
                        </span>
                    ))}
                    {riskData.tags.length > 2 && (
                        <span className="text-[10px] text-gray-400">+{riskData.tags.length - 2}</span>
                    )}
                </div>
            )}
        </div>
    );
};

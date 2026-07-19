import React, { useEffect, useState } from 'react';
import { Shield, ShieldAlert, ShieldCheck } from 'lucide-react';

interface RiskData {
    riskScore: number;
    riskLevel: string;
    tags: string[];
}

interface RiskBadgeProps {
    address: string;
}

export const RiskBadge: React.FC<RiskBadgeProps> = ({ address }) => {
    const [riskData, setRiskData] = useState<RiskData | null>(null);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        const fetchRisk = async () => {
            if (!address) return;
            try {
                const BACKEND_URL = import.meta.env.VITE_BACKEND_URL || 'http://localhost:3001';
                const res = await fetch(`${BACKEND_URL}/api/webacy/address/${address}`);
                if (res.ok) {
                    const data = await res.json();
                    if (data.status === 'success') {
                        setRiskData(data);
                    }
                }
            } catch (err) {
                console.error("Error fetching risk data", err);
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

    if (!riskData) {
        return null;
    }

    const { riskScore, riskLevel } = riskData;

    let bgColor = "bg-green-500/10";
    let textColor = "text-green-500";
    let borderColor = "border-green-500/20";
    let Icon = ShieldCheck;
    let label = "Safe";

    if (riskScore > 50) {
        bgColor = "bg-red-500/10";
        textColor = "text-red-500";
        borderColor = "border-red-500/20";
        Icon = ShieldAlert;
        label = "High Risk";
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

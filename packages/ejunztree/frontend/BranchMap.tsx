import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client"; // React 18 的正确方式

interface Branch {
    bid: number;
    title: string;
    parentId?: number | null;
    children?: Branch[];
}

interface BranchMapProps {
    domainId: string;
    currentBid: number;
}

const BranchMap: React.FC<BranchMapProps> = ({ domainId, currentBid }) => {
    const [tree, setTree] = useState<Branch[]>([]);

    useEffect(() => {
        fetch(`/tree/branches?domainId=${domainId}`)
            .then((response) => response.json())
            .then((data) => setTree(data.tree || []))
            .catch((err) => console.error("Error fetching tree:", err));
    }, [domainId]);

    const renderTree = (branches: Branch[]) => (
        <ul>
            {branches.map((branch) => (
                <li
                    key={branch.bid}
                    style={{
                        fontWeight: branch.bid === currentBid ? "bold" : "normal",
                        cursor: "pointer",
                    }}
                    onClick={() => (window.location.href = `/tree/branch/${branch.bid}`)}
                >
                    {branch.title}
                    {branch.children && renderTree(branch.children)}
                </li>
            ))}
        </ul>
    );

    return (
        <div className="branch-map">
            <h2>Branch Map</h2>
            {tree.length > 0 ? renderTree(tree) : <p>Loading...</p>}
        </div>
    );
};

// 绑定到 HTML 的 `#branch-map-root`
document.addEventListener("DOMContentLoaded", () => {
    const rootElement = document.getElementById("branch-map-root");
    if (rootElement) {
        const domainId = rootElement.getAttribute("data-domain-id") || "";
        const currentBid = Number(rootElement.getAttribute("data-current-bid")) || 0;
        createRoot(rootElement).render(<BranchMap domainId={domainId} currentBid={currentBid} />);
    }
});

export default BranchMap;

import React from "react";
import BranchMap from "./BranchMap";

interface BranchDetailProps {
    ddoc: {
        domainId: string;
        bid: number;
        title: string;
        content: string;
        parentId?: number | null;
        childrenBranches?: { bid: number; title: string; docId: string }[];
    };
}

const BranchDetail: React.FC<BranchDetailProps> = ({ ddoc }) => {
    return (
        <div className="row">
            <div className="medium-6 columns">
                <div className="section">
                    <div className="section__header">
                        <h2 className="section__title">Branch Details</h2>
                    </div>
                    <div className="section__body">
                        <h3>Title: {ddoc.title}</h3>
                        <p>Content: {ddoc.content}</p>
                        <h4>Branch Information</h4>
                        <p>
                            Branch ID: {ddoc.bid} <br />
                            {ddoc.parentId ? (
                                <>
                                    Parent Branch ID: {ddoc.parentId} <br />
                                    <strong>Type:</strong> <span>Sub-Branch</span>
                                </>
                            ) : (
                                <>
                                    <strong>Type:</strong> <span>Trunk</span>
                                </>
                            )}
                        </p>
                    </div>
                </div>
            </div>

            <div className="medium-6 columns">
                <BranchMap domainId={ddoc.domainId} currentBid={ddoc.bid} />
            </div>
        </div>
    );
};

export default BranchDetail;

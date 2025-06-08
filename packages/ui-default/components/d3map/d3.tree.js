import * as d3 from "d3";

export default function D3Tree() {
  const treeData = UiContext.d3TreeData;
  if (!treeData) return;

  const width = 1000;
  const dx = 20;
  const dy = 200;

  const svg = d3.select("#d3-tree");
  svg.selectAll("*").remove(); // 清空旧图

  svg
    .attr("width", width)
    .attr("height", 800)
    .attr("viewBox", [0, 0, width, 800])
    .attr("preserveAspectRatio", "xMidYMid meet");

  const g = svg.append("g").attr("transform", `translate(40,40)`);

  const root = d3.hierarchy(treeData);
  const treeLayout = d3.tree().nodeSize([dx, dy]);
  treeLayout(root);

  // 连接线
  g.selectAll(".link")
    .data(root.links())
    .join("path")
    .attr("class", "link")
    .attr("fill", "none")
    .attr("stroke", "#ccc")
    .attr("d", d3.linkHorizontal()
      .x(d => d.y)
      .y(d => d.x)
    );

  // 节点
  const node = g.selectAll(".node")
    .data(root.descendants())
    .join("g")
    .attr("class", "node")
    .attr("transform", d => `translate(${d.y},${d.x})`);

  node.append("circle")
    .attr("r", 5)
    .attr("fill", "#4682B4");

  node.append("text")
    .attr("dy", "0.31em")
    .attr("x", d => d.children ? -10 : 10)
    .attr("text-anchor", d => d.children ? "end" : "start")
    .text(d => d.data.name)
    .style("cursor", "pointer")
    .on("click", (event, d) => {
      const domainId = window.domainId || "{{ ddoc.domainId }}";
      const trid = window.trid || "{{ ddoc.trid }}";
      const docId = d.data.docId;
      if (docId) {
        window.location.href = `/branch/${domainId}/${trid}/${docId}`;
      }
    });
}
